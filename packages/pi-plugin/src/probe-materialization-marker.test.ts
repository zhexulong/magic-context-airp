import { expect, test } from "bun:test";
import {
	emitProbeFoldCommittedMarker,
	emitProbeM0DigestMarker,
	PROBE_FOLD_COMMITTED_PREFIX,
	PROBE_M0_DIGEST_PREFIX,
} from "./probe-materialization-marker";

/**
 * Class B diagnostic markers (D-1 approved: vendor stderr keeps them off the
 * IPC business protocol). These tests pin the marker contract:
 *   1) only a valid opaque revision / 64-hex digest emits,
 *   2) invalid input is silently ignored (never throws — a marker must not be
 *      able to break materialization),
 *   3) the payload is content-free: a digest and a revision, never m[0]/m[1] text.
 * We observe stderr by capturing process.stderr.write around each call.
 */
function captureStderr(fn) {
	const original = process.stderr.write;
	const lines = [];
	process.stderr.write = (chunk) => {
		lines.push(String(chunk));
		return true;
	};
	try {
		fn();
	} finally {
		process.stderr.write = original;
	}
	return lines.join("");
}

test("m0 digest marker emits only for a 64-hex digest and a bounded revision", () => {
	const validDigest = "a".repeat(64);
	const ok = captureStderr(() => emitProbeM0DigestMarker(validDigest, "rev_7"));
	expect(ok).toBe(`${PROBE_M0_DIGEST_PREFIX} ${validDigest} rev_7\n`);

	for (const invalid of [
		undefined,
		null,
		"",
		"not-a-digest",
		"A".repeat(64),
		"a".repeat(63),
		123,
	]) {
		const lines = captureStderr(() => emitProbeM0DigestMarker(invalid, "rev_7"));
		expect(lines).toBe("");
	}

	// The revision binds the digest to the materialization it describes: §5.4's
	// bit-stability check is "same revision, same digest", so a digest without its
	// revision cannot distinguish a stable baseline from an expected re-render.
	for (const badRevision of [undefined, null, "", "has space", 123]) {
		const lines = captureStderr(() =>
			emitProbeM0DigestMarker(validDigest, badRevision),
		);
		expect(lines).toBe("");
	}
});

test("fold-committed marker emits only for a bounded opaque revision", () => {
	const ok = captureStderr(() => emitProbeFoldCommittedMarker("rev_123"));
	expect(ok).toBe(`${PROBE_FOLD_COMMITTED_PREFIX} rev_123\n`);

	for (const invalid of [
		undefined,
		null,
		"",
		"r".repeat(129),
		"spaces in revision",
		123,
	]) {
		const lines = captureStderr(() => emitProbeFoldCommittedMarker(invalid));
		expect(lines).toBe("");
	}
});

test("the marker never carries m[0]/m[1] text — only the digest or revision", () => {
	const payload = captureStderr(() => {
		emitProbeM0DigestMarker("b".repeat(64), "rev_8");
		emitProbeFoldCommittedMarker("rev_42");
	});
	// No content-bearing field: payload length is bounded by the fixed digest.
	expect(payload).toBe(
		`${PROBE_M0_DIGEST_PREFIX} ${"b".repeat(64)} rev_8\n${PROBE_FOLD_COMMITTED_PREFIX} rev_42\n`,
	);
	expect(payload.length).toBeLessThan(220);
});
