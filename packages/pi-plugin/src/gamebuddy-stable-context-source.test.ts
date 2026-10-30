import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	__gamebuddyClearAuthoredMaterialization,
	__gamebuddyReadAuthoredMaterialization,
	__gamebuddyReplaceAuthoredMaterialization,
	GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
	materializeGameBuddyAuthoredStableCatalog,
	validateGameBuddyAuthoredStableCatalog,
} from "./gamebuddy-stable-context-source";
import { MAX_POST_HISTORY_INSTRUCTIONS_BYTES } from "./post-history-instructions-pi";

const scope = {
	continuityId: "continuity-opaque",
	sessionId: "session-opaque",
	surface: "tavern" as const,
	threadId: "thread-opaque",
	profile: {
		profileId: "profile-opaque",
		revision: 1,
		canonicalHash: "a".repeat(64),
	},
};
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string =>
	Array.isArray(value)
		? `[${value.map(canonical).join(",")}]`
		: value && typeof value === "object"
			? `{${Object.keys(value as object)
					.sort()
					.map(
						(key) =>
							`${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
					)
					.join(",")}}`
			: JSON.stringify(value);
function catalog(
	sources = [
		{
			sourceId: "scenario-1",
			kind: "scenario" as const,
			revision: "1",
			content: "A quiet tavern.",
			canonicalHash: hash("A quiet tavern."),
			budgetTokens: 100,
			totalOrderKey: "0001",
			provenance: "fixture",
		},
	],
	postHistoryInstructions?: string,
) {
	const body = {
		version: GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
		scope,
		stableSources: sources,
	};
	// The closing direction rides BESIDE the hashed body, exactly as the Host publishes it:
	// it renders after the transcript, so it must not be able to bust the m[0] cache.
	return {
		...body,
		canonicalHash: hash(canonical(body)),
		...(postHistoryInstructions === undefined
			? {}
			: { postHistoryInstructions }),
	};
}

describe("GameBuddy authored stable catalog", () => {
	it("validates the exact v2 scope and deeply freezes source data", () => {
		const value = validateGameBuddyAuthoredStableCatalog(catalog(), scope);
		expect(value.version).toBe("gamebuddy-authored-context-catalog/v2");
		expect(value.scope).toEqual(scope);
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.stableSources[0])).toBe(true);
		expect(
			() =>
				((value.stableSources[0] as { content: string }).content = "mutated"),
		).toThrow();
	});

	it("rejects a foreign thread/profile and invalid source integrity", () => {
		expect(() =>
			validateGameBuddyAuthoredStableCatalog(catalog(), {
				...scope,
				threadId: "foreign",
			}),
		).toThrow("catalog scope mismatch");
		expect(() =>
			validateGameBuddyAuthoredStableCatalog(
				catalog([
					{ ...catalog().stableSources[0], canonicalHash: "0".repeat(64) },
				]),
				scope,
			),
		).toThrow("source hash mismatch");
		expect(() =>
			validateGameBuddyAuthoredStableCatalog(
				catalog([{ ...catalog().stableSources[0], kind: "unknown" as never }]),
				scope,
			),
		).toThrow("unknown");
	});

	it("replaces and clears only the expected authored materialization", () => {
		const materialized = materializeGameBuddyAuthoredStableCatalog(
			catalog(),
			scope,
		);
		__gamebuddyReplaceAuthoredMaterialization(scope.sessionId, materialized);
		expect(__gamebuddyReadAuthoredMaterialization(scope.sessionId)).toBe(
			materialized,
		);
		const replacement = materializeGameBuddyAuthoredStableCatalog(
			catalog([
				{
					...catalog().stableSources[0],
					content: "Replacement",
					canonicalHash: hash("Replacement"),
				},
			]),
			scope,
		);
		__gamebuddyClearAuthoredMaterialization(scope.sessionId, replacement);
		expect(__gamebuddyReadAuthoredMaterialization(scope.sessionId)).toBe(
			materialized,
		);
		__gamebuddyClearAuthoredMaterialization(scope.sessionId, materialized);
		expect(
			__gamebuddyReadAuthoredMaterialization(scope.sessionId),
		).toBeUndefined();
	});

	it("rejects duplicate or malformed total-order keys", () => {
		const base = catalog().stableSources[0];
		const duplicate = catalog([
			base,
			{
				...base,
				sourceId: "persona-1",
				kind: "persona",
				totalOrderKey: base.totalOrderKey,
			},
		]);
		expect(() =>
			validateGameBuddyAuthoredStableCatalog(duplicate, scope),
		).toThrow("totalOrderKey");
		const malformed = catalog([{ ...base, totalOrderKey: "order-1" }]);
		expect(() =>
			validateGameBuddyAuthoredStableCatalog(malformed, scope),
		).toThrow("totalOrderKey");
	});

	it("renders deterministic escaped m[0] content in total-order", () => {
		const first = catalog([
			{
				sourceId: "scenario-1",
				kind: "scenario",
				revision: "1",
				content: "A <quiet> & tavern.",
				canonicalHash: hash("A <quiet> & tavern."),
				budgetTokens: 100,
				totalOrderKey: "0001",
				provenance: "fixture",
			},
			{
				sourceId: "persona-1",
				kind: "persona",
				revision: "1",
				content: "Player",
				canonicalHash: hash("Player"),
				budgetTokens: 50,
				totalOrderKey: "0000",
				provenance: "fixture",
			},
		]);
		const materialized = materializeGameBuddyAuthoredStableCatalog(
			first,
			scope,
		);
		expect(materialized.renderedBlock).toContain("&lt;quiet&gt; &amp; tavern.");
		expect(materialized.renderedBlock.indexOf('kind="persona"')).toBeLessThan(
			materialized.renderedBlock.indexOf('kind="scenario"'),
		);
		expect(materialized.budgetTokens).toBe(150);
		expect(Object.isFrozen(materialized)).toBe(true);
	});

	it("rejects volatile candidates with whitespace-only selection keys", () => {
		const volatileSource = {
			sourceId: "entry-1",
			kind: "lorebook_entry" as const,
			revision: "1",
			content: "Volatile content",
			canonicalHash: hash("Volatile content"),
			budgetTokens: 20,
			totalOrderKey: "0010",
			provenance: "test",
			selectionKeys: ["   ", "valid-key"],
		};
		const body = {
			version: GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
			scope,
			stableSources: catalog().stableSources,
			volatileSources: [volatileSource],
		};
		const c = { ...body, canonicalHash: hash(canonical(body)) };
		expect(() => validateGameBuddyAuthoredStableCatalog(c, scope)).toThrow(
			"volatile selection keys must be non-empty strings",
		);
	});

	it("rejects volatile candidates exceeding the 128 limit", () => {
		const candidates = Array.from({ length: 129 }, (_, i) => ({
			sourceId: `entry-${i}`,
			kind: "lorebook_entry" as const,
			revision: "1",
			content: `Volatile content ${i}`,
			canonicalHash: hash(`Volatile content ${i}`),
			budgetTokens: 10,
			totalOrderKey: String(i).padStart(4, "0"),
			provenance: "test",
			selectionKeys: [`key-${i}`],
		}));
		const body = {
			version: GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
			scope,
			stableSources: catalog().stableSources,
			volatileSources: candidates,
		};
		const c = { ...body, canonicalHash: hash(canonical(body)) };
		expect(() => validateGameBuddyAuthoredStableCatalog(c, scope)).toThrow(
			"volatile candidates exceed limit",
		);
	});

	it("rejects volatile candidates exceeding total budget limit", () => {
		const volatileSource = {
			sourceId: "entry-1",
			kind: "lorebook_entry" as const,
			revision: "1",
			content: "Large budget content",
			canonicalHash: hash("Large budget content"),
			budgetTokens: 50000,
			totalOrderKey: "0010",
			provenance: "test",
			selectionKeys: ["key"],
		};
		const body = {
			version: GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
			scope,
			stableSources: catalog().stableSources,
			volatileSources: [volatileSource],
		};
		const c = { ...body, canonicalHash: hash(canonical(body)) };
		expect(() => validateGameBuddyAuthoredStableCatalog(c, scope)).toThrow(
			"volatile candidates exceed total budgetTokens limit",
		);
	});
});

describe("GameBuddy card closing direction (post_history_instructions)", () => {
	const CLOSING = "收束时只说一句家常话，不要把镜头拉到旁白。";

	it("carries the field to the tail seam and leaves the rendered m[0] head byte-identical", () => {
		const without = materializeGameBuddyAuthoredStableCatalog(catalog(), scope);
		const withClosing = materializeGameBuddyAuthoredStableCatalog(
			catalog(undefined, CLOSING),
			scope,
		);
		expect(withClosing.postHistoryInstructions).toBe(CLOSING);
		// The m[0] contribution and the publication hash the context handler compares are
		// unchanged by the field: the tail cannot enter the cached prefix or its cache key.
		expect(withClosing.renderedBlock).toBe(without.renderedBlock);
		expect(withClosing.snapshotCanonicalHash).toBe(
			without.snapshotCanonicalHash,
		);
		expect(withClosing.sources).toEqual(without.sources);
		expect(withClosing.budgetTokens).toBe(without.budgetTokens);
	});

	it("leaves a card without the field exactly as it was: absence stays absence", () => {
		const materialized = materializeGameBuddyAuthoredStableCatalog(
			catalog(),
			scope,
		);
		expect(Object.hasOwn(materialized, "postHistoryInstructions")).toBe(false);
		expect(Object.hasOwn(catalog(), "postHistoryInstructions")).toBe(false);
	});

	it("keeps one 4 KB bound and refuses an over-long card instead of truncating it", () => {
		const atBound = "x".repeat(MAX_POST_HISTORY_INSTRUCTIONS_BYTES);
		expect(
			materializeGameBuddyAuthoredStableCatalog(
				catalog(undefined, atBound),
				scope,
			).postHistoryInstructions,
		).toBe(atBound);
		// UTF-8 bytes, not UTF-16 units: 2049 two-byte characters are already over.
		const multiByteOver = "收".repeat(
			Math.floor(MAX_POST_HISTORY_INSTRUCTIONS_BYTES / 3) + 1,
		);
		expect(() =>
			materializeGameBuddyAuthoredStableCatalog(
				catalog(undefined, multiByteOver),
				scope,
			),
		).toThrow(`exceeds ${MAX_POST_HISTORY_INSTRUCTIONS_BYTES} bytes`);
		for (const invalid of ["", "   ", 42]) {
			expect(() =>
				materializeGameBuddyAuthoredStableCatalog(
					catalog(undefined, invalid as never),
					scope,
				),
			).toThrow("postHistoryInstructions must be non-empty");
		}
	});
});
