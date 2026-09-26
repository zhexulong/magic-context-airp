import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { injectM0M1Pi } from "./inject-compartments-pi";
import {
	PROBE_FOLD_COMMITTED_PREFIX,
	PROBE_M0_DIGEST_PREFIX,
} from "./probe-materialization-marker";
import { createTestDb, userMessage } from "./test-utils.test";

/**
 * The two Class B markers exist so an external audit harness can position and
 * score long-horizon memory probes. Their emission rule is the whole contract,
 * so it is pinned here rather than left to the call-site comment:
 *
 *   - `m0_digest` is emitted on EVERY pass that presents an m[0] block, because
 *     the `prefix_bit_stability` dimension compares m[0] against a baseline on
 *     every turn. A digest emitted only on folds would leave that dimension
 *     blind on exactly the turns it is meant to judge.
 *   - `fold_committed` is emitted only when m[0] COVERAGE ADVANCES — new
 *     compartment content certified into the baseline. A HARD bust that merely
 *     re-renders (model change, system-hash change) is not a fold, and the
 *     materializer is also reached for `cache_invalid` / `drift` repairs. Keying
 *     the marker on "the materializer ran" would report folds that never happened
 *     and make the fold probe ask its question before the memory folded.
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

function foldMarkers(payload) {
	return payload.split("\n").filter((line) => line.startsWith(PROBE_FOLD_COMMITTED_PREFIX));
}

function digestMarkers(payload) {
	return payload.split("\n").filter((line) => line.startsWith(PROBE_M0_DIGEST_PREFIX));
}

function piState(sessionId, cwd) {
	return {
		sessionId,
		projectIdentity: resolveProjectIdentity(cwd),
		projectDirectory: cwd,
		injectionBudgetTokens: 10_000,
	};
}

function compartment(seq, body) {
	return {
		sequence: seq,
		startMessage: seq,
		endMessage: seq,
		startMessageId: `entry-${seq}`,
		endMessageId: `entry-${seq}`,
		title: `T${seq}`,
		content: body,
		p1: body,
	};
}

const baseHard = {
	systemHash: "sys-v1",
	modelKey: "anthropic/opus",
	cacheExpired: false,
	lastResponseTime: 0,
};

describe("Class B memory-probe marker emission", () => {
	it("emits no fold marker for a first render that certifies no new compartment", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-marker-first-"));
		try {
			const state = { ...piState("ses-marker-first", cwd), hardSignals: baseHard };
			const messages = [userMessage("hi", 10)];
			const payload = captureStderr(() => {
				injectM0M1Pi(state, db, messages as never, ["entry-0"]);
			});
			// A first render with no compartments presents m[0] (so the digest is
			// observable) but folds nothing, so no fold may be claimed.
			expect(digestMarkers(payload).length).toBe(1);
			expect(foldMarkers(payload)).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("emits a fold marker when a compartment is certified into the m[0] baseline", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-marker-fold-"));
		try {
			const state = { ...piState("ses-marker-fold", cwd), hardSignals: baseHard };
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha body")]);
			const payload = captureStderr(() => {
				injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);
			});
			expect(digestMarkers(payload).length).toBe(1);
			expect(foldMarkers(payload).length).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("does NOT emit a fold marker for a HARD re-render that folds no compartment", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-marker-modelchange-"));
		try {
			const state = { ...piState("ses-marker-modelchange", cwd), hardSignals: baseHard };
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha body")]);
			// Baseline pass folds the compartment once.
			const baseline = captureStderr(() => {
				injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);
			});
			expect(foldMarkers(baseline).length).toBe(1);

			// A model change is a HARD bust: m[0] re-renders, but no new compartment
			// content is certified, so this is not a fold.
			const switched = {
				...state,
				hardSignals: { ...baseHard, modelKey: "anthropic/sonnet" },
			};
			const payload = captureStderr(() => {
				injectM0M1Pi(switched, db, [userMessage("again", 11)] as never, ["entry-0"]);
			});
			// The digest still fires (m[0] was re-presented and must be comparable),
			// but the fold claim must not.
			expect(digestMarkers(payload).length).toBeGreaterThan(0);
			expect(foldMarkers(payload)).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps the digest stable across a pure replay of the same materialization", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-marker-stable-"));
		try {
			const state = { ...piState("ses-marker-stable", cwd), hardSignals: baseHard };
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha body")]);
			const first = captureStderr(() => {
				injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);
			});
			const second = captureStderr(() => {
				injectM0M1Pi(state, db, [userMessage("hi", 10)] as never, ["entry-0"]);
			});
			// Same revision, same digest: this is the bit-stability the dimension
			// judges, and the revision is bound to the digest so a re-render cannot
			// be mistaken for drift.
			expect(digestMarkers(second)).toEqual(digestMarkers(first));
			expect(second).not.toContain("null");
		} finally {
			closeQuietly(db);
		}
	});
});
