/**
 * Class B diagnostic markers for long-horizon memory probes (owner-approved
 * D-1: vendor stderr keeps them off the versioned IPC business protocol).
 *
 * The m[0] materialization digest and the fold-commit fact are Magic
 * Context-owned observations. They are emitted HERE on stderr, with a fixed
 * prefix and no payload body, so an external audit harness can position and
 * score probes (§5.4 / §5.5 of the long-horizon memory probe design) without
 * the Host ever touching m[0]/m[1] bytes or the fold internals. Absence of a
 * marker is a probe `observability_gap`, never a failure.
 *
 * Emitting is opt-in per materialization call site; ordinary runtime behaviour
 * is unchanged unless the caller requests the marker.
 */
export const PROBE_FOLD_COMMITTED_PREFIX = "[probe:fold_committed]";
export const PROBE_M0_DIGEST_PREFIX = "[probe:m0_digest]";
/**
 * Which memories are in the m[0] the provider is about to see.
 *
 * Added for the L2 (assembly) funnel stage. The digest marker above proves m[0]
 * CHANGED; it cannot answer "is this fact in there?", which is the question the
 * memory loop actually asks when a probe fails. This marker carries the ids
 * Magic Context itself persisted alongside the m[0] snapshot, so the harness can
 * decide presence WITHOUT the vendor knowing what a seed is: the vendor reports
 * its own assembled set, and the caller compares that against whatever it seeded.
 */
export const PROBE_M0_MEMORY_IDS_PREFIX = "[probe:m0_memory_ids]";
/**
 * Which narrative chapters are in the m[0] the provider is about to see.
 *
 * Same Class B contract as the memory-ids marker, for the chapter rollup
 * (AIRP fork): the harness learns HOW MANY sealed chapters rendered and a
 * digest of the rendered chapter block, so it can verify (a) chapters reach
 * m[0] after a fold, and (b) the chapter block stays byte-identical across
 * unrelated passes (prefix-cache stability). Count and digest only — never
 * chapter text.
 */
export const PROBE_M0_CHAPTERS_PREFIX = "[probe:m0_chapters]";
/**
 * WHICH authored sources are in the m[0] the provider is about to see.
 *
 * Same Class B contract as the sibling markers, for the always-on background
 * seam: the harness learns which KINDS of reviewed context Magic Context
 * compiled into the Tier 2 baseline (for example `lorebook_constant`), so "the
 * card's always-on world book reached m[0]" is verifiable from the Chat surface
 * without launching the game. Kinds only - never source text, never source ids,
 * never counts of anything but the rendered set.
 */
export const PROBE_M0_SOURCES_PREFIX = "[probe:m0_sources]";
const MAX_SOURCE_KINDS = 16;
const SOURCE_KIND = /^[a-z][a-z0-9_]{0,63}$/;
const OPAQUE_REVISION = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
/** Hard cap on the id list, so the marker line stays bounded regardless of render. */
const MAX_RENDERED_MEMORY_IDS = 512;

function writeStderr(line: string): void {
	// Best-effort, never throwing: the marker is a diagnostic observation, not a
	// business path, so a closed stderr must not be able to break materialization.
	try {
		process.stderr.write(`${line}\n`);
	} catch {
		// ignore
	}
}

/** Fold-commit marker: emitted only after the materialize transaction COMMIT, so a
 * crash in the pre-COMMIT window can never produce a marker claiming durability. */
export function emitProbeFoldCommittedMarker(revision: unknown): void {
	if (typeof revision !== "string" || !OPAQUE_REVISION.test(revision)) return;
	writeStderr(`${PROBE_FOLD_COMMITTED_PREFIX} ${revision}`);
}

/** m[0] digest marker: emitted at the materialization boundary with the SHA-256 of
 * the m[0] bytes presented to the provider this pass (post mural handling), which
 * is the prefix `prefix_bit_stability` actually judges. Never carries m[0] text.
 *
 * The revision is bound to the same marker because §5.4's bit-stability check is
 * "same materialization revision, same digest"; a digest without its revision
 * cannot distinguish a stable baseline from an expected re-render, so the
 * comparison would report a defect for every legitimate fold. */
export function emitProbeM0DigestMarker(digestHex: unknown, revision: unknown): void {
	if (typeof digestHex !== "string" || !SHA256_HEX.test(digestHex)) return;
	if (typeof revision !== "string" || !OPAQUE_REVISION.test(revision)) return;
	writeStderr(`${PROBE_M0_DIGEST_PREFIX} ${digestHex} ${revision}`);
}

/** m[0] rendered-memory marker: emitted at the SAME materialization boundary as the
 * digest, carrying the ids Magic Context persisted with that m[0] snapshot.
 *
 * Ids only - never content, never counts of anything but the rendered set - so a
 * caller learns which of ITS OWN facts were assembled without the vendor ever
 * needing to know what those facts mean. Bounded on every axis: a malformed
 * revision or a non-array is ignored, and the id list is capped so a pathological
 * render cannot produce an unbounded stderr line.
 */
export function emitProbeM0MemoryIdsMarker(
		revision: unknown,
		renderedMemoryIds: unknown,
	): void {
		if (typeof revision !== "string" || !OPAQUE_REVISION.test(revision)) return;
		if (!Array.isArray(renderedMemoryIds)) return;
		const ids: number[] = [];
		for (const value of renderedMemoryIds) {
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) continue;
			ids.push(value);
			if (ids.length >= MAX_RENDERED_MEMORY_IDS) break;
		}
		// A sorted, de-duplicated list makes the marker deterministic for a given set,
		// so a harness can compare two passes without depending on render order.
		const unique = [...new Set(ids)].sort((left, right) => left - right);
		const list = unique.length > 0 ? unique.join(",") : "-";
		writeStderr(`${PROBE_M0_MEMORY_IDS_PREFIX} ${revision} ${list}`);
	}

	/** Authored-source marker: which kinds of stable/volatile context rendered into
	 * this pass's m[0]. Never carries source content or identifiers. */
export function emitProbeM0SourcesMarker(
		revision: unknown,
		stableKinds: unknown,
		volatileKinds: unknown,
	): void {
		if (typeof revision !== "string" || !OPAQUE_REVISION.test(revision)) return;
		// A sorted, de-duplicated list makes the marker deterministic for a given set,
		// so a harness can compare two passes without depending on render order.
		const list = (value: unknown): string => {
			if (!Array.isArray(value)) return "-";
			const kinds: string[] = [];
			for (const kind of value) {
				if (typeof kind !== "string" || !SOURCE_KIND.test(kind)) continue;
				if (!kinds.includes(kind)) kinds.push(kind);
				if (kinds.length >= MAX_SOURCE_KINDS) break;
			}
			return kinds.length > 0 ? kinds.sort().join(",") : "-";
		};
		writeStderr(
			`${PROBE_M0_SOURCES_PREFIX} ${revision} stable=${list(stableKinds)} volatile=${list(volatileKinds)}`,
		);
	}

	/** Chapter rollup marker: count + block digest, emitted at the same materialization
	 * boundary as the memory-ids marker. Never carries chapter text. */
export function emitProbeM0ChaptersMarker(
		revision: unknown,
		chapterCount: unknown,
		chaptersBlockDigest: unknown,
	): void {
		if (typeof revision !== "string" || !OPAQUE_REVISION.test(revision)) return;
		if (typeof chapterCount !== "number" || !Number.isSafeInteger(chapterCount) || chapterCount < 0) return;
		const digest =
			typeof chaptersBlockDigest === "string" && SHA256_HEX.test(chaptersBlockDigest)
				? chaptersBlockDigest
				: "-";
		writeStderr(`${PROBE_M0_CHAPTERS_PREFIX} ${revision} ${chapterCount} ${digest}`);
	}