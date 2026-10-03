import { expect, test } from "bun:test";
import {
	emitProbeFoldCommittedMarker,
	emitProbeM0DigestMarker,
	emitProbeM0MemoryIdsMarker,
	emitProbeM0ChaptersMarker,
	PROBE_FOLD_COMMITTED_PREFIX,
	PROBE_M0_DIGEST_PREFIX,
	PROBE_M0_MEMORY_IDS_PREFIX,
	PROBE_M0_CHAPTERS_PREFIX,
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

test("m0 memory-ids marker reports the assembled id set, never content", () => {
	// The L2 answer: ``which of my facts reached the prompt``. The vendor reports
	// only the ids it assembled, so it never needs to know which id a caller seeded.
	const ok = captureStderr(() => emitProbeM0MemoryIdsMarker("rev_9", [3, 1, 2]));
	// Sorted and de-duplicated so two passes with the same set compare equal
	// regardless of render order.
	expect(ok).toBe(`${PROBE_M0_MEMORY_IDS_PREFIX} rev_9 1,2,3\n`);

	// An EMPTY set is a real answer, not an omission: it says "m[0] was rendered
	// with no memories this pass", which is exactly what an L2 miss needs to see.
	const empty = captureStderr(() => emitProbeM0MemoryIdsMarker("rev_10", []));
	expect(empty).toBe(`${PROBE_M0_MEMORY_IDS_PREFIX} rev_10 -\n`);
});

	test("m0 memory-ids marker ignores malformed input and stays bounded", () => {
		for (const badRevision of [undefined, null, "", "has space", 123, "r".repeat(129)]) {
			expect(captureStderr(() => emitProbeM0MemoryIdsMarker(badRevision, [1]))).toBe("");
		}
		// Not an array (including a Set, which a caller might pass by mistake) is a
		// no-op rather than a throw: a diagnostic must never break materialization.
		for (const badIds of [undefined, null, "1,2,3", 42, new Set([1, 2])]) {
			expect(captureStderr(() => emitProbeM0MemoryIdsMarker("rev_11", badIds))).toBe("");
		}
		// Non-integer / negative / unsafe ids are dropped instead of poisoning the line.
		const filtered = captureStderr(() =>
			emitProbeM0MemoryIdsMarker("rev_12", [1, -1, 2.5, Number.NaN, Number.MAX_VALUE, "3", 4]),
		);
		expect(filtered).toBe(`${PROBE_M0_MEMORY_IDS_PREFIX} rev_12 1,4\n`);
	});

	test("m0 chapters marker reports count + block digest, never chapter text", () => {
		const digest = "a".repeat(64);
		const ok = captureStderr(() =>
			emitProbeM0ChaptersMarker("rev_13", 2, digest),
		);
		expect(ok).toBe(`${PROBE_M0_CHAPTERS_PREFIX} rev_13 2 ${digest}\n`);

		// Zero chapters is a real answer (no rollup yet), with a dash digest.
		const zero = captureStderr(() =>
			emitProbeM0ChaptersMarker("rev_14", 0, "-"),
		);
		expect(zero).toBe(`${PROBE_M0_CHAPTERS_PREFIX} rev_14 0 -\n`);

		// Never carries chapter text: a non-hex digest becomes a dash, ids never leak.
		const notHex = captureStderr(() =>
			emitProbeM0ChaptersMarker("rev_15", 2, "not a hash but maybe chapter text"),
		);
		expect(notHex).toBe(`${PROBE_M0_CHAPTERS_PREFIX} rev_15 2 -\n`);
	});

	test("m0 chapters marker ignores malformed input and stays bounded", () => {
		for (const badRevision of [undefined, null, "", "has space", 123, "r".repeat(129)]) {
			expect(captureStderr(() => emitProbeM0ChaptersMarker(badRevision, 1, "a".repeat(64)))).toBe("");
		}
		// Bad count (negative / non-integer / missing) is a no-op.
		for (const badCount of [undefined, null, -1, 1.5, "2", Number.NaN]) {
			expect(captureStderr(() => emitProbeM0ChaptersMarker("rev_16", badCount, "a".repeat(64)))).toBe("");
		}
	});
