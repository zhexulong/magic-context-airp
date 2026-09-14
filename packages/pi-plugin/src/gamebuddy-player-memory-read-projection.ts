import { join } from "node:path";
import {
    type Memory,
    MemoryCommandFacade,
} from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentityOrFallback } from "@magic-context/core/features/magic-context/memory/project-identity";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";

/**
 * The vendor store is project-scoped.  A GameBuddy continuity gets a stable,
 * private project identity beneath that project so independently mounted
 * continuities never read or mutate one another's player-managed memories.
 */
export function resolveGameBuddyMemoryProjectPath(
    runtimeCwd: string,
    continuityId: string,
): string {
    // GameBuddy passes its private product runtime root, not an interactive Pi
    // project cwd. It may legitimately live beneath the player's home directory.
    const projectIdentity = resolveProjectIdentityOrFallback(runtimeCwd);
    return `gamebuddy:${projectIdentity}:continuity:${continuityId}`;
}

export type GameBuddyPlayerMemoryProfileBinding = Readonly<{
    continuityId: string;
    runtimeCwd: string;
    profileId?: string;
    profileRevision?: number;
    profileCanonicalHash?: string;
}>;

export type GameBuddyPlayerMemoryReadInput = Readonly<{
    continuityId: string;
    profileId?: string;
    profileRevision?: number;
    profileCanonicalHash?: string;
}>;

export type GameBuddyPlayerMemoryReadView = Readonly<{
    stateToken: string;
    content: string;
    category: "semantic" | "interaction";
    status: "active" | "permanent" | "archived";
    sourceRefs?: readonly string[];
}>;

export type GameBuddyPlayerMemoryReadProjection = Readonly<{
    listMemories(
        input: GameBuddyPlayerMemoryReadInput,
    ): Promise<readonly GameBuddyPlayerMemoryReadView[]>;
    getMemory(
        input: GameBuddyPlayerMemoryReadInput & Readonly<{ stateToken: string }>,
    ): Promise<GameBuddyPlayerMemoryReadView>;
}>;

export function validateMemoryProfileBinding(args: GameBuddyPlayerMemoryProfileBinding): void {
    if (typeof args.continuityId !== "string" || args.continuityId.length === 0)
        throw new Error("invalid_memory_profile_binding");
    if (args.profileId !== undefined) {
        if (typeof args.profileId !== "string" || args.profileId.length === 0 || args.profileId === "unknown")
            throw new Error("invalid_memory_profile_binding");
    }
    if (args.profileRevision !== undefined) {
        if (!Number.isSafeInteger(args.profileRevision) || args.profileRevision < 1)
            throw new Error("invalid_memory_profile_binding");
    }
    if (args.profileCanonicalHash !== undefined) {
        if (typeof args.profileCanonicalHash !== "string" || !/^[a-f0-9]{64}$/.test(args.profileCanonicalHash))
            throw new Error("invalid_memory_profile_binding");
    }
}

export function assertMemoryProfileMatch(
    bound: GameBuddyPlayerMemoryProfileBinding,
    input: GameBuddyPlayerMemoryReadInput,
): void {
    if (input.continuityId !== bound.continuityId)
        throw new Error("gamebuddy_memory_continuity_mismatch");
    if (bound.profileId !== undefined && input.profileId !== undefined && input.profileId !== bound.profileId)
        throw new Error("gamebuddy_memory_profile_mismatch");
    if (bound.profileRevision !== undefined && input.profileRevision !== undefined && input.profileRevision !== bound.profileRevision)
        throw new Error("gamebuddy_memory_profile_mismatch");
    if (bound.profileCanonicalHash !== undefined && input.profileCanonicalHash !== undefined && input.profileCanonicalHash !== bound.profileCanonicalHash)
        throw new Error("gamebuddy_memory_profile_mismatch");
}

function sourceRefs(memory: Memory): readonly string[] | undefined {
    try {
        const metadata: unknown =
            memory.metadataJson === null ? undefined : JSON.parse(memory.metadataJson);
        const values =
            metadata && typeof metadata === "object" && !Array.isArray(metadata)
                ? (metadata as Record<string, unknown>).source_refs
                : undefined;
        return Array.isArray(values) && values.every((value) => typeof value === "string")
            ? Object.freeze([...values])
            : undefined;
    } catch {
        return undefined;
    }
}

function view(memory: Memory, stateToken: string): GameBuddyPlayerMemoryReadView | undefined {
    // The shared Magic Context store can contain other product categories.
    // They are outside the player-management contract, so omit them rather
    // than failing an otherwise safe bounded projection.
    if (memory.category !== "SEMANTIC_MEMORY" && memory.category !== "INTERACTION_EPISODE")
        return undefined;
    return Object.freeze({
        stateToken,
        content: memory.content,
        category: memory.category === "SEMANTIC_MEMORY" ? "semantic" : "interaction",
        status: memory.status,
        ...(sourceRefs(memory) === undefined ? {} : { sourceRefs: sourceRefs(memory) }),
    });
}

/** Bound read-only projection. It deliberately exposes no Memory mutation method. */
export function createGameBuddyPlayerMemoryReadProjection(
    args: GameBuddyPlayerMemoryProfileBinding,
): GameBuddyPlayerMemoryReadProjection {
    validateMemoryProfileBinding(args);
    const projectPath = resolveGameBuddyMemoryProjectPath(args.runtimeCwd, args.continuityId);
    const open = async (): Promise<MemoryCommandFacade> => {
        const db = await openDatabaseAsync(
            join(args.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"),
        );
        if (!db) throw new Error("gamebuddy_memory_storage_unavailable");
        return new MemoryCommandFacade(db);
    };
    return Object.freeze({
        async listMemories(input) {
            assertMemoryProfileMatch(args, input);
            return (await open())
                .list(projectPath)
                .flatMap((entry) => {
                    const projected = view(entry.memory, entry.stateToken);
                    return projected === undefined ? [] : [projected];
                });
        },
        async getMemory(input) {
            assertMemoryProfileMatch(args, input);
            const entry = (await open())
                .list(projectPath)
                .find((candidate) => candidate.stateToken === input.stateToken);
            if (!entry) throw new Error("gamebuddy_memory_not_found");
            const projected = view(entry.memory, entry.stateToken);
            if (projected === undefined) throw new Error("gamebuddy_memory_not_found");
            return projected;
        },
    });
}
