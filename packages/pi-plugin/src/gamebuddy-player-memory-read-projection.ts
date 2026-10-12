import { join } from "node:path";
import {
	type Memory,
	MemoryCommandFacade,
} from "@magic-context/core/features/magic-context/memory";
import { getDeclaredProjectIdentity } from "@magic-context/core/shared/harness";
import { resolveProjectIdentityOrFallback } from "@magic-context/core/features/magic-context/memory/project-identity";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";
import {
	getChaptersForProject,
	type ChapterStatus,
} from "@magic-context/core/features/magic-context/chapter-storage";

/**
 * The vendor store is project-scoped.  A GameBuddy continuity gets a stable,
 * private project identity beneath that project so independently mounted
 * continuities never read or mutate one another's player-managed memories.
 */
export function resolveGameBuddyMemoryProjectPath(
	runtimeCwd: string,
	continuityId: string,
): string {
	// A host that declared its render-side partition (setDeclaredProjectIdentity)
	// supplies the FULL final path already; returning it unchanged makes this
	// function idempotent for that host. Without this, the declared value flows
	// back through resolveProjectIdentityOrFallback and the path becomes
	// `gamebuddy:gamebuddy:<identity>:continuity:<id>:continuity:<id>` - the
	// double-wrap the memory loop measured: management wrote a doubled path while
	// the render session bound the single-wrapped one, so the two halves of one
	// continuity could never meet.
	const declared = getDeclaredProjectIdentity();
	if (declared !== undefined) return declared;
	// GameBuddy passes its private product runtime root, not an interactive Pi
	// project cwd. It may legitimately live beneath the player's home directory
	// (a disposable fixture root under %TEMP%, or a product data root under
	// %LOCALAPPDATA%), so the home-project gate must not apply here: the very
	// first call (before the host has a declared identity to return) resolves
	// the base identity this wrapper partitions, and a home-directory runtime is
	// the GameBuddy product's normal case, never a user's interactive project.
	const projectIdentity = resolveProjectIdentityOrFallback(runtimeCwd, true);
	return `gamebuddy:${projectIdentity}:continuity:${continuityId}`;
}

export type GameBuddyPlayerMemoryProfileBinding = Readonly<{
	continuityId: string;
	runtimeCwd: string;
	profileId: string;
	profileRevision: number;
}>;

export type GameBuddyPlayerMemoryReadInput = Readonly<{
	continuityId: string;
	profileId: string;
	profileRevision: number;
}>;

export type GameBuddyPlayerMemoryReadView = Readonly<{
  stateToken: string;
  content: string;
  category: "semantic" | "interaction";
  status: "active" | "permanent" | "archived";
  /**
   * Who wrote the row, in the store's own vocabulary (`historian` | `agent` | `dreamer` | `user`).
   *
   * The management surface has always allowed a player to edit and archive ANY row, but it could not
   * say which rows the player wrote themselves and which the companion's own machinery produced - so
   * the two were indistinguishable exactly where a player decides what to trust. The value is carried
   * verbatim: the store owns the vocabulary, and the display wording belongs to the surface.
   */
  sourceType: string;
  sourceRefs?: readonly string[];
}>;

/**
 * One narrative chapter as the player reads it: the stretch of time it covers, what the fold wrote (or
 * what the player replaced it with), and whether the player has touched it.
 *
 * `status` is carried verbatim from the store: `sealed` is the fold's own text, `edited` is the
 * player's, and `deleted` is a tombstone the panel still shows, so a removal stays visible and auditable
 * instead of silently vanishing.
 */
export type GameBuddyPlayerChapterView = Readonly<{
	chapterId: number;
	title: string;
	spanStartSequence: number;
	spanEndSequence: number;
	startDate: string;
	endDate: string;
	content: string;
	status: ChapterStatus;
	editedAt: number | null;
}>;

export type GameBuddyPlayerMemoryReadProjection = Readonly<{
	listChapters(
		input: GameBuddyPlayerMemoryReadInput,
	): Promise<readonly GameBuddyPlayerChapterView[]>;
	listMemories(
		input: GameBuddyPlayerMemoryReadInput,
	): Promise<readonly GameBuddyPlayerMemoryReadView[]>;
	getMemory(
		input: GameBuddyPlayerMemoryReadInput & Readonly<{ stateToken: string }>,
	): Promise<GameBuddyPlayerMemoryReadView>;
}>;

export function validateMemoryProfileBinding(
	args: GameBuddyPlayerMemoryProfileBinding,
): void {
	if (!args || typeof args !== "object")
		throw new Error("invalid_memory_profile_binding");
	if (
		typeof args.continuityId !== "string" ||
		args.continuityId.trim().length === 0
	)
		throw new Error("invalid_memory_profile_binding");
	if (
		typeof args.runtimeCwd !== "string" ||
		args.runtimeCwd.trim().length === 0
	)
		throw new Error("invalid_memory_profile_binding");
	if (
		typeof args.profileId !== "string" ||
		args.profileId.trim().length === 0 ||
		args.profileId === "unknown"
	)
		throw new Error("invalid_memory_profile_binding");
	if (
		typeof args.profileRevision !== "number" ||
		!Number.isSafeInteger(args.profileRevision) ||
		args.profileRevision < 1
	)
		throw new Error("invalid_memory_profile_binding");
}

export function assertMemoryProfileMatch(
	bound: GameBuddyPlayerMemoryProfileBinding,
	input: GameBuddyPlayerMemoryReadInput,
): void {
	if (!input || typeof input !== "object")
		throw new Error("gamebuddy_memory_profile_mismatch");
	if (input.continuityId !== bound.continuityId)
		throw new Error("gamebuddy_memory_continuity_mismatch");
	if (
		typeof input.profileId !== "string" ||
		input.profileId !== bound.profileId
	)
		throw new Error("gamebuddy_memory_profile_mismatch");
	if (
		typeof input.profileRevision !== "number" ||
		input.profileRevision !== bound.profileRevision
	)
		throw new Error("gamebuddy_memory_profile_mismatch");
}

function sourceRefs(memory: Memory): readonly string[] | undefined {
	try {
		const metadata: unknown =
			memory.metadataJson === null
				? undefined
				: JSON.parse(memory.metadataJson);
		const values =
			metadata && typeof metadata === "object" && !Array.isArray(metadata)
				? (metadata as Record<string, unknown>).source_refs
				: undefined;
		return Array.isArray(values) &&
			values.every((value) => typeof value === "string")
			? Object.freeze([...values])
			: undefined;
	} catch {
		return undefined;
	}
}

function view(
	memory: Memory,
	stateToken: string,
): GameBuddyPlayerMemoryReadView | undefined {
	// The shared Magic Context store can contain other product categories.
	// They are outside the player-management contract, so omit them rather
	// than failing an otherwise safe bounded projection.
	if (
		memory.category !== "SEMANTIC_MEMORY" &&
		memory.category !== "INTERACTION_EPISODE"
	)
		return undefined;
  return Object.freeze({
    stateToken,
    content: memory.content,
    category:
      memory.category === "SEMANTIC_MEMORY" ? "semantic" : "interaction",
    status: memory.status,
    sourceType: memory.sourceType,
    ...(sourceRefs(memory) === undefined
      ? {}
      : { sourceRefs: sourceRefs(memory) }),
  });
}

/** Bound read-only projection. It deliberately exposes no Memory mutation method. */
export function createGameBuddyPlayerMemoryReadProjection(
	args: GameBuddyPlayerMemoryProfileBinding,
): GameBuddyPlayerMemoryReadProjection {
	validateMemoryProfileBinding(args);
	const projectPath = resolveGameBuddyMemoryProjectPath(
		args.runtimeCwd,
		args.continuityId,
	);
	const open = async (): Promise<MemoryCommandFacade> => {
		const db = await openDatabaseAsync(
			join(args.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"),
		);
		if (!db) throw new Error("gamebuddy_memory_storage_unavailable");
		return new MemoryCommandFacade(db);
	};
	return Object.freeze({
async listChapters(input) {
	assertMemoryProfileMatch(args, input);
	const db = await openDatabaseAsync(
		join(args.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"),
	);
	if (!db) throw new Error("gamebuddy_memory_storage_unavailable");
	// Continuity-scoped, like every other panel read: the runtime root and its memory partition are
	// shared, and a Pi session only partitions one run's own compartments.
	return getChaptersForProject(db, projectPath).map((chapter) =>
		Object.freeze({
			chapterId: chapter.id,
			title: chapter.title,
			spanStartSequence: chapter.spanStartSequence,
			spanEndSequence: chapter.spanEndSequence,
			startDate: chapter.startDate,
			endDate: chapter.endDate,
			content: chapter.content,
			status: chapter.status,
			editedAt: chapter.editedAt,
		}),
	);
},

		async listMemories(input) {
			assertMemoryProfileMatch(args, input);
			return (await open()).list(projectPath).flatMap((entry) => {
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
			if (projected === undefined)
				throw new Error("gamebuddy_memory_not_found");
			return projected;
		},
	});
}
