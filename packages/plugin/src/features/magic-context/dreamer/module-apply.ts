import { SingleStoreMigrationRequiredError } from "../../../hooks/magic-context/single-store-refusal";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import type { MemoryCategory } from "../memory/types";
import type { ClassifyModuleClient } from "./classify";

const loggedNotOwnerProjects = new Set<string>();

export function logDreamerNotOwnerOnce(projectIdentity: string): void {
    if (loggedNotOwnerProjects.has(projectIdentity)) return;
    loggedNotOwnerProjects.add(projectIdentity);
    log(`[dreamer] ${projectIdentity}: ${new SingleStoreMigrationRequiredError().message}`);
}

export class DreamerModuleFailureError extends Error {
    readonly transient = true;
    constructor(operation: string, cause: unknown) {
        super(
            `Rust dreamer ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
        );
        this.name = "DreamerModuleFailureError";
    }
}

export type DreamerModuleClient = ClassifyModuleClient;

export interface DreamerModuleRoute {
    moduleClient: DreamerModuleClient;
    moduleSessionId: string;
    moduleProjectRoot: string;
    moduleCommandId: string;
}

/** Both writers use the same rows; routing no longer changes ownership or row ids. */
export async function resolveDreamerModuleRoute(args: {
    db: Database;
    projectIdentity: string;
    projectRoot: string;
    transformMode?: "ts" | "rust";
    moduleClient?: DreamerModuleClient;
    commandId: string;
}): Promise<DreamerModuleRoute | undefined> {
    if (args.transformMode === "ts" || !args.moduleClient) return undefined;
    return {
        moduleClient: args.moduleClient,
        moduleSessionId: args.projectIdentity,
        moduleProjectRoot: args.projectRoot,
        moduleCommandId: args.commandId,
    };
}

/**
 * Apply memory learnings through the Rust module authority. A module-managed
 * project must NOT also write these rows with the TypeScript store: the module's
 * durable state is the fence, so a second writer would race it. One command id
 * per learning lets the module de-duplicate a batch the host retries.
 */
export async function writeMemoryLearningsThroughModule(args: {
    moduleRoute: DreamerModuleRoute;
    projectIdentity: string;
    learnings: readonly { category: MemoryCategory; content: string }[];
}): Promise<number> {
    let written = 0;
    for (const learning of args.learnings) {
        try {
            const response = await args.moduleRoute.moduleClient.call({
                sessionId: args.moduleRoute.moduleSessionId,
                projectRoot: args.moduleRoute.moduleProjectRoot,
                method: "ctx_memory",
                body: {
                    name: "ctx_memory",
                    arguments: {
                        action: "write",
                        memory_project: args.projectIdentity,
                        category: learning.category,
                        content: learning.content,
                        command_id: `${args.moduleRoute.moduleCommandId}:${written}`,
                    },
                },
            });
            const body = ((response as { result?: unknown })?.result ?? response) as {
                ok?: unknown;
                error?: unknown;
            };
            if (body?.ok === false || body?.error) {
                throw new Error("module rejected the memory learning");
            }
            written += 1;
        } catch (error) {
            throw new DreamerModuleFailureError("ctx_memory learning write", error);
        }
    }
    return written;
}

export interface ModuleMemoryIdentity {
    moduleId: number;
    normalizedHash: string;
}

/** Capture the shared row's hash for the module's compare-before-write check. */
export function getModuleMemoryIdentities(
    db: Database,
    projectIdentity: string,
    contextIds: readonly number[],
): Map<number, ModuleMemoryIdentity> {
    if (contextIds.length === 0) return new Map();
    const placeholders = contextIds.map(() => "?").join(", ");
    const rows = db
        .prepare(
            `SELECT id, normalized_hash FROM memories WHERE project_path = ? AND id IN (${placeholders})`,
        )
        .all(projectIdentity, ...contextIds) as Array<{ id: number; normalized_hash: string }>;
    return new Map(
        rows.map((row) => [row.id, { moduleId: row.id, normalizedHash: row.normalized_hash }]),
    );
}
