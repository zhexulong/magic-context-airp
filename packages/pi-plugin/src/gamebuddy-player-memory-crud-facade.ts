import { join } from "node:path";
import {
	deleteChapter,
	updateChapterContent,
} from "@magic-context/core/features/magic-context/chapter-storage";
import {
	type MemoryCommandFacade,
	MemoryCommandFacade as MemoryFacade,
} from "@magic-context/core/features/magic-context/memory";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";
import {
	assertMemoryProfileMatch,
	createGameBuddyPlayerMemoryReadProjection,
	type GameBuddyPlayerChapterView,
	type GameBuddyPlayerMemoryProfileBinding,
	type GameBuddyPlayerMemoryReadInput,
	type GameBuddyPlayerMemoryReadProjection,
	type GameBuddyPlayerMemoryReadView,
	resolveGameBuddyMemoryProjectPath,
	validateMemoryProfileBinding,
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
			/**
			 * Replace a chapter's body with the player's own words. Nothing else moves: the span, the title and
			 * the fold's own record stay as the fold wrote them.
			 */
			updateChapter(
				input: GameBuddyPlayerMemoryReadInput &
					Readonly<{ chapterId: number; content: string }>,
			): Promise<GameBuddyPlayerChapterView>;
			/**
			 * Remove a chapter from the companion's history as a TOMBSTONE: the row keeps its span, so a later
			 * fold cannot re-derive the interval and bring it back, and the body stays for audit.
			 */
			deleteChapter(
				input: GameBuddyPlayerMemoryReadInput & Readonly<{ chapterId: number }>,
			): Promise<GameBuddyPlayerChapterView>;
			create(
				input: GameBuddyPlayerMemoryReadInput & Readonly<{ content: string }>,
			): Promise<GameBuddyPlayerMemoryReadView>;
			update(
				input: GameBuddyPlayerMemoryReadInput &
					Readonly<{
						stateToken: string;
						content: string;
					}>,
			): Promise<GameBuddyPlayerMemoryReadView>;
			archive(
				input: GameBuddyPlayerMemoryReadInput &
					Readonly<{ stateToken: string }>,
			): Promise<GameBuddyPlayerMemoryReadView>;
		}>;

export function createGameBuddyPlayerMemoryCrudFacade(
	args: GameBuddyPlayerMemoryProfileBinding,
): GameBuddyPlayerMemoryCrudFacade {
	validateMemoryProfileBinding(args);
	const projectPath = resolveGameBuddyMemoryProjectPath(
		args.runtimeCwd,
		args.continuityId,
	);
	const read = createGameBuddyPlayerMemoryReadProjection(args);
	// The chapter mutations belong to the storage layer, so this facade opens the database itself
	// rather than going through the Memory command facade.
	const openChapterDb = async () =>
		await openDatabaseAsync(
			join(args.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"),
		);
	const open = async (): Promise<MemoryCommandFacade> => {
		const db = await openDatabaseAsync(
			join(args.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"),
		);
		if (!db) throw new Error("gamebuddy_memory_storage_unavailable");
		return new MemoryFacade(db);
	};
	const player = Object.freeze({
		principal: "player_direct" as const,
		delegated: false,
	});

	return Object.freeze({
		...read,
		async updateChapter(input) {
			assertMemoryProfileMatch(args, input);
			const db = await openChapterDb();
			if (!db) throw new Error("gamebuddy_memory_storage_unavailable");
			if (
				!updateChapterContent(db, {
					projectPath,
					chapterId: input.chapterId,
					content: input.content,
					now: Date.now(),
				})
			)
				throw new Error("gamebuddy_chapter_not_found");
			const updated = (await read.listChapters(input)).find(
				(chapter) => chapter.chapterId === input.chapterId,
			);
			if (updated === undefined) throw new Error("gamebuddy_chapter_not_found");
			return updated;
		},
		async deleteChapter(input) {
			assertMemoryProfileMatch(args, input);
			const db = await openChapterDb();
			if (!db) throw new Error("gamebuddy_memory_storage_unavailable");
			if (
				!deleteChapter(db, {
					projectPath,
					chapterId: input.chapterId,
					now: Date.now(),
				})
			)
				throw new Error("gamebuddy_chapter_not_found");
			const removed = (await read.listChapters(input)).find(
				(chapter) => chapter.chapterId === input.chapterId,
			);
			if (removed === undefined || removed.status !== "deleted")
				throw new Error("gamebuddy_chapter_delete_readback_failed");
			return removed;
		},
		async create(input) {
			assertMemoryProfileMatch(args, input);
			const result = (await open()).create({
				projectPath,
				category: "SEMANTIC_MEMORY",
				content: input.content,
				sourceType: "user",
				actor: player,
			});
			return await read.getMemory({ ...input, stateToken: result.stateToken });
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
			return await read.getMemory({ ...input, stateToken: result.stateToken });
		},
		async archive(input) {
			assertMemoryProfileMatch(args, input);
			const result = (await open()).archiveByStateToken(
				{
					projectPath,
					stateToken: input.stateToken,
					actor: player,
				},
				"Archived by player management",
			);
			const reread = await read.getMemory({
				...input,
				stateToken: result.stateToken,
			});
			if (reread.status !== "archived") {
				throw new Error("gamebuddy_memory_archive_readback_failed");
			}
			return reread;
		},
	});
}
