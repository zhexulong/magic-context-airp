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
const OPAQUE_REVISION = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

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