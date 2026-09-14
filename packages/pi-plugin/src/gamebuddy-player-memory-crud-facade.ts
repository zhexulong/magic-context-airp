import { join } from "node:path";
import {
    type MemoryCommandFacade,
    MemoryCommandFacade as MemoryFacade,
} from "@magic-context/core/features/magic-context/memory";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";
import {
    assertMemoryProfileMatch,
    createGameBuddyPlayerMemoryReadProjection,
    resolveGameBuddyMemoryProjectPath,
    validateMemoryProfileBinding,
    type GameBuddyPlayerMemoryProfileBinding,
    type GameBuddyPlayerMemoryReadInput,
    type GameBuddyPlayerMemoryReadProjection,
    type GameBuddyPlayerMemoryReadView,
} from "./gamebuddy-player-memory-read-projection";

export type {
    GameBuddyPlayerMemoryProfileBinding,
    GameBuddyPlayerMemoryReadInput,
};

/**
 * Browser-management CRUD boundary for player-owned Memory. It is bound only
 * to the supplied continuity and runtime project; it is neither a Pi tool nor
 * a provider/runtime callback capability.
 */
export type GameBuddyPlayerMemoryCrudFacade =
    GameBuddyPlayerMemoryReadProjection &
    Readonly<{
        create(
            input: GameBuddyPlayerMemoryReadInput & Readonly<{ content: string }>,
        ): Promise<GameBuddyPlayerMemoryReadView>;
        update(
            input: GameBuddyPlayerMemoryReadInput & Readonly<{
                stateToken: string;
                content: string;
            }>,
        ): Promise<GameBuddyPlayerMemoryReadView>;
        archive(
            input: GameBuddyPlayerMemoryReadInput & Readonly<{ stateToken: string }>,
        ): Promise<void>;
    }>;

export function createGameBuddyPlayerMemoryCrudFacade(
    args: GameBuddyPlayerMemoryProfileBinding,
): GameBuddyPlayerMemoryCrudFacade {
    validateMemoryProfileBinding(args);
    const projectPath = resolveGameBuddyMemoryProjectPath(args.runtimeCwd, args.continuityId);
    const read = createGameBuddyPlayerMemoryReadProjection(args);
    const open = async (): Promise<MemoryCommandFacade> => {
        const db = await openDatabaseAsync(
            join(args.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"),
        );
        if (!db) throw new Error("gamebuddy_memory_storage_unavailable");
        return new MemoryFacade(db);
    };
    const player = Object.freeze({ principal: "player_direct" as const, delegated: false });

    return Object.freeze({
        ...read,
        async create(input) {
            assertMemoryProfileMatch(args, input);
            const result = (await open()).create({
                projectPath,
                category: "SEMANTIC_MEMORY",
                content: input.content,
                sourceType: "user",
                actor: player,
            });
            return (await read.getMemory({ ...input, stateToken: result.stateToken }));
        },
        async update(input) {
            assertMemoryProfileMatch(args, input);
            // Resolve and compare the opaque token inside the vendor's
            // BEGIN IMMEDIATE transaction so two browser writes cannot both
            // succeed from one stale read-back.
            const result = (await open()).updateByStateToken({
                projectPath,
                stateToken: input.stateToken,
                content: input.content,
                actor: player,
            });
            return (await read.getMemory({ ...input, stateToken: result.stateToken }));
        },
        async archive(input) {
            assertMemoryProfileMatch(args, input);
            (await open()).archiveByStateToken(
                {
                    projectPath,
                    stateToken: input.stateToken,
                    actor: player,
                },
                "Archived by player management",
            );
        },
    });
}
