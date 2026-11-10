import type { PiPresetSegments } from "./context-handler";

/**
 * Host-owned SillyTavern preset segments, published per project directory.
 *
 * The seam in `context-handler.ts` takes the rendered segments and the Host's assembly function as
 * two fields of the options object, and that object is built HERE (`index.ts`
 * `buildContextOptions` / `resolveContextOptionsForProject`) - the embedding Host never constructs
 * it and cannot pass an option through the extension factory, whose signature is `(pi)`. So the
 * Host's half has to arrive the way this package's other embedding inputs do: a process-local
 * registry, published through the `./tavern` subpath and read once per pass, beside
 * `magic-context.pi.gamebuddy-authored-context-registry` and
 * `magic-context.pi.embedded-historian-binding`.
 *
 * The registry lives on `globalThis` under a `Symbol.for` key for the reason the authored-context
 * one records at length: `bun build` emits the root entry and the tavern entry as separate chunks
 * (so each copy of a module-local Map would diverge), and Pi loads the extension through jiti with
 * `moduleCache: false`. Whichever copy publishes and whichever copy reads see one map.
 *
 * `assemble` is a live function, not data: it closes over the Host's preset, so it can only cross
 * this boundary as an object reference in the same process. That is also why there is no
 * serialisation here and no schema: the vendor never reads a preset, it calls the Host's assembly
 * and serves what comes back.
 */
export type GameBuddyPresetAssembly = (
	input: PiPresetSegments & { messages: readonly unknown[] },
) => { messages: unknown[]; prefixHash: string };

export type GameBuddyPresetSegmentsPublication = Readonly<{
	segments: PiPresetSegments;
	assemble: GameBuddyPresetAssembly;
}>;

const PRESET_SEGMENTS_REGISTRY_SLOT = Symbol.for(
	"magic-context.pi.gamebuddy-preset-segments",
);

type GameBuddyPresetSegmentsRegistry = Map<
	string,
	GameBuddyPresetSegmentsPublication
>;

function presetSegmentsRegistry(): GameBuddyPresetSegmentsRegistry {
	const global = globalThis as typeof globalThis & {
		[PRESET_SEGMENTS_REGISTRY_SLOT]?: GameBuddyPresetSegmentsRegistry;
	};
	const existing = global[PRESET_SEGMENTS_REGISTRY_SLOT];
	if (existing !== undefined) return existing;
	const created: GameBuddyPresetSegmentsRegistry = new Map();
	global[PRESET_SEGMENTS_REGISTRY_SLOT] = created;
	return created;
}

/**
 * State the segments one project directory's next pass assembles from.
 *
 * Keyed by the project directory because that is the only identity the per-pass resolver has
 * (`ctx.cwd`), and one Host runtime root is one project directory. A later publication for the same
 * directory replaces the earlier one: the Host republishes per turn, so "which preset is in force"
 * stays a fact it can change between turns without the vendor holding a cache of its own.
 */
export function publishGameBuddyPresetSegments(
	projectDir: string,
	publication: GameBuddyPresetSegmentsPublication,
): void {
	presetSegmentsRegistry().set(projectDir, publication);
}

/**
 * Withdraw a directory's publication, so the next pass assembles nothing from a preset.
 *
 * This is the Host unbinding: the seam's call site requires BOTH fields, so a cleared registry
 * entry means the served array is byte-identical to a build without this feature.
 */
export function clearGameBuddyPresetSegments(projectDir: string): void {
	presetSegmentsRegistry().delete(projectDir);
}

/** The publication the per-pass resolver spreads into this pass's options, or `undefined` for none. */
export function __gamebuddyReadPresetSegments(
	projectDir: string,
): GameBuddyPresetSegmentsPublication | undefined {
	return presetSegmentsRegistry().get(projectDir);
}
