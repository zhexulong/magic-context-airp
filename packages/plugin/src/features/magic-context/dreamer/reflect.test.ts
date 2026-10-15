/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { getMemoriesByProject, insertMemory } from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { parseReflectLearnings } from "./reflect";
import { createDreamTaskExecutor } from "./task-executor";
import { REFLECT_SYSTEM_PROMPT } from "./task-prompts";
import { leaseKeyFor } from "./task-registry";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

const PROJECT = "/repo/reflect";

function reflectClient(answer: string, prompts: string[]) {
    return {
        session: {
            list: mock(async () => ({ data: [] })),
            create: mock(async () => ({ data: { id: "reflect-child" } })),
            prompt: mock(async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                prompts.push(args.body?.parts?.[0]?.text ?? "");
                return {};
            }),
            messages: mock(async () => ({ data: assistantMessages(answer) })),
            delete: mock(async () => ({})),
        },
    };
}

async function runReflect(args: {
    answer: string;
    memoryDomain?: "coding-project" | "ongoing-interaction";
    seed?: string;
}) {
    db = freshDb();
    // Two seeds, for two different reasons: the reflection's input is the project's compartment stream - the
    // long-term narrative this product keeps - while the memory insert keeps the fixture's project visible to
    // the promotion-side bookkeeping the assertions below read (owner ruling (a), 2026-10-15).
    insertMemory(db, {
        projectPath: PROJECT,
        category: "SEMANTIC_MEMORY",
        content: args.seed ?? "You told me you like keeping the long way round when it rains.",
    });
    db.prepare(
        `INSERT INTO compartments
            (session_id, sequence, start_message, end_message, title, content, importance, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        "reflect-seed-session",
        0,
        1,
        2,
        "A long way round in the rain",
        args.seed ?? "You told me you like keeping the long way round when it rains.",
        50,
        Date.now(),
    );
    const prompts: string[] = [];
    const executor = createDreamTaskExecutor({
        client: reflectClient(args.answer, prompts) as never,
        sessionDirectory: PROJECT,
        openOpenCodeDb: () => null,
        // Default to the companion runtime's domain; only the coding-project case
        // overrides it.
        memoryDomain: args.memoryDomain ?? "ongoing-interaction",
    });
    const outcome = await executor(
        { task: "reflect", schedule: "0 5 * * *", timeoutMinutes: 20 },
        {
            db,
            projectIdentity: PROJECT,
            holderId: "reflect-holder",
            leaseKey: leaseKeyFor("reflect", PROJECT),
        },
    );
    return { outcome, prompts, db };
}

describe("parseReflectLearnings", () => {
    test("refuses an answer with no learnings block instead of reading it as nothing to say", () => {
        expect(() =>
            parseReflectLearnings("I thought about it a lot.", "ongoing-interaction"),
        ).toThrow("no learnings block");
    });

    test("an empty block is a valid answer", () => {
        expect(parseReflectLearnings("<learnings></learnings>", "ongoing-interaction")).toEqual([]);
    });

    test("keeps route=memory lines in the active domain and drops a coding category", () => {
        const xml = `<learnings>
            <learning route="memory" category="SEMANTIC_MEMORY">You told me you want the options before a choice that matters.</learning>
            <learning route="memory" category="PROJECT_RULES">Verify a tool is callable before claiming support.</learning>
            <learning route="observation">Prefers the smallest effective fix first.</learning>
        </learnings>`;
        expect(parseReflectLearnings(xml, "ongoing-interaction")).toEqual([
            {
                route: "memory",
                category: "SEMANTIC_MEMORY",
                content: "You told me you want the options before a choice that matters.",
            },
        ]);
    });
});

describe("reflection prompt", () => {
    test("carries the companion voice and the promotion gates", () => {
        // Voice: these lines land on the player's Memory panel and back in the
        // companion's own context, so the companion is "I" and the player is "you".
        expect(REFLECT_SYSTEM_PROMPT).toContain('Write "I" for yourself and "you" for the player');
        expect(REFLECT_SYSTEM_PROMPT).toContain(
            'No role labels ("the player", "the user", "the assistant", "the agent")',
        );
        expect(REFLECT_SYSTEM_PROMPT).toContain(
            "No message numbers, sequence indices, timestamps, tool names, receipts, or internal markers",
        );
        // Promotion gates: stated/confirmed material may be kept; model inference
        // must be marked as such and never asserted as a fact about the player.
        expect(REFLECT_SYSTEM_PROMPT).toContain("stated or confirmed it");
        expect(REFLECT_SYSTEM_PROMPT).toContain("model inference");
        expect(REFLECT_SYSTEM_PROMPT).toContain(
            "Never state an inferred trait, mood, preference, or relationship interpretation",
        );
        // Completed activity and world state stay episodic.
        expect(REFLECT_SYSTEM_PROMPT).toContain("stay episodic");
        // An empty answer is a legitimate answer, not a failure.
        expect(REFLECT_SYSTEM_PROMPT).toContain("An empty answer is a valid answer");
    });
});

describe("createDreamTaskExecutor — reflect", () => {
    test("writes a domain-legal Memory row under the memory lease", async () => {
        const {
            outcome,
            prompts,
            db: database,
        } = await runReflect({
            answer: `<learnings>
                <learning route="memory" category="INTERACTION_EPISODE">We agreed to leave the unopened cellar rooms for another day.</learning>
            </learnings>`,
        });
        expect(outcome.status).toBe("completed");
        // The prompt offers exactly the active domain's taxonomy, read from the
        // same source the historian's promotion path uses.
        expect(prompts[0]).toContain("SEMANTIC_MEMORY, INTERACTION_EPISODE");
        expect(prompts[0]).not.toContain("PROJECT_RULES");
        const written = getMemoriesByProject(database, PROJECT).filter(
            (memory) => memory.category === "INTERACTION_EPISODE",
        );
        expect(written.map((memory) => memory.content)).toEqual([
            "We agreed to leave the unopened cellar rooms for another day.",
        ]);
        // The row is an ordinary, player-owned Memory entry that names the task it
        // came from — never a parallel store.
        expect(written[0]?.metadataJson).toBe(JSON.stringify({ source: "reflect" }));
        expect(written[0]?.sourceType).toBe("dreamer");
    });

    test("refuses a coding category in the companion runtime's domain", async () => {
        const { outcome, db: database } = await runReflect({
            answer: `<learnings>
                <learning route="memory" category="PROJECT_RULES">Verify a tool is callable before claiming support.</learning>
            </learnings>`,
        });
        expect(outcome.status).toBe("completed");
        expect(getMemoriesByProject(database, PROJECT).map((memory) => memory.category)).toEqual([
            "SEMANTIC_MEMORY",
        ]);
    });

    test("a coding project keeps its own taxonomy and refuses the interaction categories", async () => {
        const { prompts, db: database } = await runReflect({
            memoryDomain: "coding-project",
            answer: `<learnings>
                <learning route="memory" category="SEMANTIC_MEMORY">You told me you want the options before a choice that matters.</learning>
                <learning route="memory" category="CONSTRAINTS">External rate limits apply when calling the provider in bulk.</learning>
            </learnings>`,
        });
        expect(prompts[0]).toContain("### Categories you may use\nPROJECT_RULES");
        expect(prompts[0]).not.toContain("### Categories you may use\nSEMANTIC_MEMORY");
        const written = getMemoriesByProject(database, PROJECT).map((memory) => memory.category);
        expect(written).toContain("CONSTRAINTS");
        expect(written).not.toContain("INTERACTION_EPISODE");
    });
});
