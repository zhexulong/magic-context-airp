import { DREAMER_REFLECT_AGENT } from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
import { createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { teardownChildSession } from "../../../shared/child-session-teardown";
import { describeError } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import type { MemoryDomain } from "../memory/domain";
import { getMemorySelectColumns, isMemoryRow, toMemory } from "../memory/storage-memory";
import { recordChildInvocation } from "../subagent-token-capture";
import { runHiddenSingleShotPrompt } from "./hidden-single-shot";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "./lease";
import { type DreamerModuleRoute, writeMemoryLearningsThroughModule } from "./module-apply";
import {
    applyRetrospectiveLearnings,
    type ParsedRetrospectiveLearning,
    parseRetrospectiveLearnings,
    validateRetrospectiveLearningText,
} from "./retrospective-learnings";
import { getTaskScheduleState } from "./storage-task-schedule";
import {
    buildReflectPrompt,
    REFLECT_SYSTEM_PROMPT,
    type ReflectPromptMemory,
} from "./task-prompts";

/**
 * How many durable memories one reflection reads. The window is the newest slice
 * of the project's own memory stream — never raw game or session state, so the
 * task stays game-agnostic and the prompt stays bounded.
 */
export const REFLECT_WINDOW_LIMIT = 40;

/** The child session title; also the dreamer telemetry task key. */
const REFLECT_TITLE = "magic-context-dream-reflect";

/**
 * The memory rows a reflection reads: created or changed since its last run,
 * newest first. The same rows a player sees on the Memory panel — a projection,
 * not the live world.
 */
export function readReflectWindow(
    db: Database,
    projectIdentity: string,
    since: number,
    limit: number = REFLECT_WINDOW_LIMIT,
): ReflectPromptMemory[] {
    // Owner ruling (a), 2026-10-15: read the stream this product actually keeps. GameBuddy runs with promotion
    // off, so the historian's long-term memory is the compartment stream - the narrative the player reads as
    // history and chapters - while `memories` stays empty by configuration. Reading that table made every
    // reflection run a no-op with nothing to say.
    const rows = db
        .prepare(
            `SELECT sequence, title, content, created_at
               FROM compartments
              WHERE created_at > ?
              ORDER BY created_at DESC, sequence DESC
              LIMIT ?`,
        )
        .all(since, limit) as Array<{ title: string | null; content: string | null }>;
    return rows.map((row) => ({
        category: "INTERACTION_EPISODE",
        content: [row.title, row.content]
            .map((part) => (typeof part === "string" ? part.trim() : ""))
            .filter((part) => part.length > 0)
            .join("\n"),
    }));
}

/**
 * Parse one reflection answer. Reflection has no obligation to produce anything,
 * so an empty `<learnings>` block is a valid answer — but an answer with no
 * `<learnings>` element at all is a broken contract, and treating it as "nothing
 * to say" would silently turn a garbled reply into a successful run.
 */
export function parseReflectLearnings(
    text: string,
    memoryDomain: MemoryDomain,
): ParsedRetrospectiveLearning[] {
    if (!/<learnings\b/i.test(text)) {
        throw new Error("reflection returned no learnings block");
    }
    // Reflection writes Memory only; an observation line belongs to the user
    // profile and is not this task's output.
    return parseRetrospectiveLearnings(text, memoryDomain).filter(
        (learning) => learning.route === "memory",
    );
}

export interface ReflectTaskArgs {
    db: Database;
    /** Filesystem-relative identity of the project the reflection writes under. */
    projectIdentity: string;
    client?: PluginContext["client"];
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    /** The active memory domain; its taxonomy is the category vocabulary. */
    memoryDomain: MemoryDomain;
    /** Set when the Rust module owns this project's memories; it gets the writes. */
    moduleRoute?: DreamerModuleRoute;
    model?: ModelInput;
    fallbackModels?: readonly ModelInput[];
    language?: string;
}

export interface ReflectTaskResult {
    learnings: number;
    memoryWritten: number;
    rejected: number;
}

export async function runReflectTask(args: ReflectTaskArgs): Promise<ReflectTaskResult> {
    const result: ReflectTaskResult = { learnings: 0, memoryWritten: 0, rejected: 0 };

    const lastRunAt = getTaskScheduleState(args.db, args.projectIdentity, "reflect")?.lastRunAt;
    const memories = readReflectWindow(args.db, args.projectIdentity, lastRunAt ?? 0);
    if (memories.length === 0) {
        log("[dreamer] reflect: no durable memory to reflect on");
        return result;
    }

    const prompt = buildReflectPrompt({
        projectIdentity: args.projectIdentity,
        memoryDomain: args.memoryDomain,
        memories,
    });

    let agentSessionId: string | null = null;
    let promptSettled = false;
    const startedAt = Date.now();
    let invocationRecorded = false;
    const recordInvocation = (params: {
        status: "completed" | "failed";
        messages?: unknown[];
        error?: unknown;
    }) => {
        if (!args.parentSessionId || invocationRecorded) return;
        invocationRecorded = true;
        recordChildInvocation({
            db: args.db,
            parentSessionId: args.parentSessionId,
            harness: args.hiddenCompletionExecutor?.capabilities.harness ?? "opencode",
            subagent: "dreamer",
            // Must match the dream_runs row name so the dashboard's task GROUP BY
            // join lines up.
            task: "reflect",
            startedAt,
            status: params.status,
            messages: params.messages,
            error: params.error,
        });
    };

    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(
        args.db,
        args.holderId,
        args.leaseKey,
        (reason) => {
            log(`[dreamer] reflect: lease lost (${reason}) — aborting`);
            abortController.abort();
        },
        args.leaseAcquisition,
    );

    try {
        const remainingBudgetMs = Math.max(0, args.deadline - Date.now());
        let learnings: ParsedRetrospectiveLearning[];
        if (args.hiddenCompletionExecutor) {
            const run = await runHiddenSingleShotPrompt({
                executor: args.hiddenCompletionExecutor,
                parentSessionId: args.parentSessionId,
                sessionDirectory: args.sessionDirectory ?? "",
                agent: DREAMER_REFLECT_AGENT,
                system: REFLECT_SYSTEM_PROMPT,
                prompt,
                title: REFLECT_TITLE,
                callContext: "dreamer:reflect",
                model: args.model,
                fallbackModels: args.fallbackModels,
                language: args.language,
                timeoutMs: remainingBudgetMs,
                signal: abortController.signal,
                metadata: { task: "reflect" },
                parse: (text) => parseReflectLearnings(text, args.memoryDomain),
            });
            promptSettled = true;
            recordInvocation({ status: "completed", messages: run.completion.messages });
            learnings = run.validated;
        } else {
            const client = args.client;
            if (!client) {
                throw new Error("Reflection needs a client or a completion carrier.");
            }
            const createResponse = await createChildSessionWithFence({
                client,
                db: args.db,
                parentSessionId: args.parentSessionId,
                title: REFLECT_TITLE,
                directory: args.sessionDirectory,
            });
            const created = shared.normalizeSDKResponse(
                createResponse,
                null as { id?: string } | null,
                { preferResponseOnMissingData: true },
            );
            agentSessionId = typeof created?.id === "string" ? created.id : null;
            if (!agentSessionId) {
                const error = new Error("Could not create reflection session.");
                recordInvocation({ status: "failed", error });
                throw error;
            }

            const childSessionId = agentSessionId;
            const reflectRun = await shared.promptSyncWithValidatedOutputRetry(
                client,
                {
                    path: { id: childSessionId },
                    query: { directory: args.sessionDirectory },
                    body: {
                        agent: DREAMER_REFLECT_AGENT,
                        system: withContentLanguageDirective(REFLECT_SYSTEM_PROMPT, args.language),
                        ...modelBodyField(args.model),
                        parts: [{ type: "text", text: prompt, synthetic: true }],
                    },
                },
                {
                    timeoutMs: remainingBudgetMs,
                    signal: abortController.signal,
                    fallbackModels: args.fallbackModels,
                    callContext: "dreamer:reflect",
                    fetchOutput: async () => {
                        const messagesResponse = await client.session.messages({
                            path: { id: childSessionId },
                            query: { directory: args.sessionDirectory, limit: 50 },
                        });
                        return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                            preferResponseOnMissingData: true,
                        });
                    },
                    validateOutput: (messages) =>
                        parseReflectLearnings(
                            extractLatestAssistantText(messages) ?? "",
                            args.memoryDomain,
                        ),
                },
            );
            promptSettled = true;
            recordInvocation({ status: "completed", messages: reflectRun.output });
            learnings = reflectRun.validated;
        }

        result.learnings = learnings.length;
        const sourceSessionId = "reflect";
        if (args.moduleRoute) {
            // Module-managed project: the module owns these rows, so the reflection
            // must never also write them with the TypeScript store.
            const writable = learnings.filter((learning) => {
                const reason = validateRetrospectiveLearningText(learning.content);
                if (reason || !learning.category) {
                    result.rejected += 1;
                    return false;
                }
                return true;
            });
            result.memoryWritten = await writeMemoryLearningsThroughModule({
                moduleRoute: args.moduleRoute,
                projectIdentity: args.projectIdentity,
                learnings: writable.flatMap((learning) =>
                    learning.category
                        ? [{ category: learning.category, content: learning.content }]
                        : [],
                ),
            });
        } else {
            const applied = runLeaseGuardedWrite(
                args.db,
                args.holderId,
                args.leaseKey,
                (): ReturnType<typeof applyRetrospectiveLearnings> =>
                    applyRetrospectiveLearnings({
                        db: args.db,
                        projectIdentity: args.projectIdentity,
                        sourceSessionId,
                        learnings,
                        // Reflection writes Memory; a user-profile observation is not
                        // this task's output and parseReflectLearnings already dropped it.
                        userMemoryCollectionEnabled: false,
                        source: "reflect",
                    }),
            );
            result.memoryWritten = applied.memoryWritten;
            result.rejected += applied.rejected.length;
        }
        log(
            `[dreamer] reflect: learnings=${result.learnings} memory=${result.memoryWritten} rejected=${result.rejected}`,
        );
        return result;
    } catch (error) {
        const errorDescription = describeError(error);
        log(
            `[dreamer] reflect: failed: ${errorDescription.brief}`,
            errorDescription.stackHead ? { stackHead: errorDescription.stackHead } : undefined,
        );
        recordInvocation({ status: "failed", error });
        // Rethrow so the executor records a failed run and the scheduler does not
        // advance past work the reflection never saw.
        throw error;
    } finally {
        heartbeat.stop();
        if (args.client) {
            await teardownChildSession({
                client: args.client,
                sessionId: agentSessionId,
                sessionDirectory: args.sessionDirectory,
                promptSettled,
                privacySensitive: true,
                context: "[dreamer] reflect",
                log,
            });
        }
    }
}
