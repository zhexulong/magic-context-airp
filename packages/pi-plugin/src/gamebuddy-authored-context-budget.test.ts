import { describe, expect, test } from "bun:test";
import {
	authoredTokensForContent,
	canCheckAuthoredContextBudget,
	computeAuthoredContextBudget,
	type GameBuddyAuthoredContextWindowFacts,
	refuseAuthoredContextOverBudget,
} from "./gamebuddy-authored-context-budget";

/**
 * THE AUTHORED HALF'S TOTAL BOUND, AND THE REFUSAL THAT NAMES IT.
 *
 * <p>
 * The numbers these tests are written against are the Host's own measurement of the shipped
 * 32,768/8,192 geometry (`host/src/authored-context-budget.test.ts`, committed at 873c2d09): floor
 * 8,787 tokens, history budget 2,396, `usableSoft` 24,576 — so the authored half has 13,393 tokens
 * of room. That is the figure this module's bound reproduces from its inputs, and the reason a
 * total bound is needed at all: 13,393 is BELOW `MAX_AUTHORED_VOLATILE_BUDGET_TOKENS` (32,768), so
 * neither half's own ceiling can bound the pair.
 * </p>
 */

/** The shipped Game geometry, as the Host measured it. */
const SHIPPED: GameBuddyAuthoredContextWindowFacts = Object.freeze({
	usableSoft: 24_576,
	floorTokens: 8_787,
	historyBudgetTokens: 2_396,
});

/** The authored room the shipped geometry leaves: 24,576 − 8,787 − 2,396. */
const SHIPPED_AUTHORED_BUDGET = 13_393;

/** The fixed terms together: what is spent before any authored text is counted. */
const FIXED = SHIPPED.floorTokens + SHIPPED.historyBudgetTokens;

/** A wide window (131,072 with the same 8,192 reserve), for the "a larger model helps" case. */
const WIDE: GameBuddyAuthoredContextWindowFacts = Object.freeze({
	usableSoft: 122_880,
	floorTokens: SHIPPED.floorTokens,
	historyBudgetTokens: 17_986,
});

describe("the authored budget is derived from the window, not chosen", () => {
	test("the shipped geometry leaves exactly the room the Host's curve reported", () => {
		const budget = computeAuthoredContextBudget(SHIPPED, 0);
		expect(budget.authoredBudgetTokens).toBe(SHIPPED_AUTHORED_BUDGET);
		expect(budget.authoredBudgetTokens).toBe(
			SHIPPED.usableSoft - SHIPPED.floorTokens - SHIPPED.historyBudgetTokens,
		);
	});

	test("the authored budget is below the volatile ceiling", () => {
		// The whole reason this module exists, asserted rather than asserted-in-prose: if the shipped
		// window's authored room ever rose above 32,768, the volatile ceiling would already cover it
		// and this guard would be redundant. It does not.
		expect(SHIPPED_AUTHORED_BUDGET).toBeLessThan(32_768);
	});

	test("a larger window leaves proportionally more authored room", () => {
		// The action the refusal recommends has to be TRUE, so this is the assertion behind it: the
		// same authored text fits a bigger window, because only the fixed terms scale with it.
		const wide = computeAuthoredContextBudget(WIDE, 20_000);
		expect(wide.headroomTokens).toBeGreaterThan(0);
		const narrow = computeAuthoredContextBudget(SHIPPED, 20_000);
		expect(narrow.headroomTokens).toBeLessThan(0);
		// The same 20,000 authored tokens: refused on the shipped window, admitted on the wide one.
		expect(refuseAuthoredContextOverBudget(SHIPPED, 20_000)).toBeDefined();
		expect(
			refuseAuthoredContextOverBudget(WIDE, 20_000),
		).toBeUndefined();
	});
});

describe("the boundary is exact", () => {
	test("exactly at the budget fits; one token over does not", () => {
		// CORRECT: Range. The comparison is `<=`, so the last admissible token is admitted and the
		// next one is refused. A guard that used `<` would refuse a catalogue that fits.
		expect(refuseAuthoredContextOverBudget(SHIPPED, SHIPPED_AUTHORED_BUDGET)).toBeUndefined();
		expect(refuseAuthoredContextOverBudget(SHIPPED, SHIPPED_AUTHORED_BUDGET + 1)).toBeDefined();
	});

	test("an empty authored half always fits", () => {
		expect(refuseAuthoredContextOverBudget(SHIPPED, 0)).toBeUndefined();
	});

	test("the total is floor + history + authored, and headroom is the window minus that", () => {
		const budget = computeAuthoredContextBudget(SHIPPED, 4_000);
		expect(budget.inputTokens).toBe(SHIPPED.floorTokens + SHIPPED.historyBudgetTokens + 4_000);
		expect(budget.headroomTokens).toBe(SHIPPED.usableSoft - budget.inputTokens);
		expect(budget.headroomTokens).toBe(SHIPPED_AUTHORED_BUDGET - 4_000);
	});
});

describe("an unanswerable window is skipped, never treated as a refusal", () => {
	// Existence/Range: the disguise this guard exists to remove must not be reintroduced here. A
	// missing or nonsensical window is not evidence the prompt is too large, and refusing on it
	// would break a cold start or a fixture for a reason that has nothing to do with the player.
	test.each([
		["undefined facts", undefined],
		["zero window", { usableSoft: 0, floorTokens: 8_787, historyBudgetTokens: 2_396 }],
		["negative window", { usableSoft: -1, floorTokens: 8_787, historyBudgetTokens: 2_396 }],
		["NaN window", { usableSoft: Number.NaN, floorTokens: 8_787, historyBudgetTokens: 2_396 }],
		["zero floor", { usableSoft: 24_576, floorTokens: 0, historyBudgetTokens: 2_396 }],
		["NaN floor", { usableSoft: 24_576, floorTokens: Number.NaN, historyBudgetTokens: 2_396 }],
		["negative history", { usableSoft: 24_576, floorTokens: 8_787, historyBudgetTokens: -1 }],
		["NaN history", { usableSoft: 24_576, floorTokens: 8_787, historyBudgetTokens: Number.NaN }],
	])("%s cannot be checked", (_label, facts) => {
		expect(
			canCheckAuthoredContextBudget(facts as GameBuddyAuthoredContextWindowFacts | undefined),
		).toBe(false);
		expect(
			refuseAuthoredContextOverBudget(facts as GameBuddyAuthoredContextWindowFacts, 10_000_000),
		).toBeUndefined();
	});

	test("a zero history budget is answerable: history may legitimately be off", () => {
		// `>= 0`, unlike the other terms: a surface that renders no history has a real budget of
		// zero, and that is a fact the comparison can use rather than a reason to skip it.
		const noHistory = { usableSoft: 24_576, floorTokens: 8_787, historyBudgetTokens: 0 };
		expect(canCheckAuthoredContextBudget(noHistory)).toBe(true);
		expect(computeAuthoredContextBudget(noHistory, 0).authoredBudgetTokens).toBe(24_576 - 8_787);
	});

	test("a nonsense authored figure is skipped rather than refused", () => {
		expect(refuseAuthoredContextOverBudget(SHIPPED, Number.NaN)).toBeUndefined();
		expect(refuseAuthoredContextOverBudget(SHIPPED, -1)).toBeUndefined();
		expect(refuseAuthoredContextOverBudget(SHIPPED, Number.POSITIVE_INFINITY)).toBeUndefined();
	});
});

describe("the refusal names the authored budget and the actions that help", () => {
	test("the message carries the authored size, the budget, the fixed cost and the window", () => {
		const refusal = refuseAuthoredContextOverBudget(SHIPPED, 20_000);
		expect(refusal).toBeDefined();
		if (refusal === undefined) return;
		expect(refusal.code).toBe("gamebuddy_authored_context_over_budget");
		// Every number a player needs to act is IN the message; "too big" alone is a dead end.
		expect(refusal.message).toContain("20000");
		expect(refusal.message).toContain(String(SHIPPED_AUTHORED_BUDGET));
		expect(refusal.message).toContain(String(SHIPPED.floorTokens));
		expect(refusal.message).toContain(String(SHIPPED.historyBudgetTokens));
		expect(refusal.message).toContain(String(SHIPPED.usableSoft));
		// The overage is stated as its own figure, not left to subtraction.
		expect(refusal.message).toContain(String(20_000 - SHIPPED_AUTHORED_BUDGET));
	});

	test("the message names only actions that are true", () => {
		const refusal = refuseAuthoredContextOverBudget(SHIPPED, 20_000);
		expect(refusal).toBeDefined();
		if (refusal === undefined) return;
		// Removing/shortening entries and splitting the book both shrink the authored total.
		expect(refusal.message).toMatch(/remove|shorten/i);
		expect(refusal.message).toMatch(/split/i);
		// A larger window is named, and the test above proves it is genuinely a fix.
		expect(refusal.message).toMatch(/larger context window/i);
		// It must NOT claim anything was truncated: nothing is dropped, the whole catalogue is refused.
		expect(refusal.message).not.toMatch(/truncat|dropped|shortened for you|reduced/i);
	});

	test("the refusal does not read as a storage failure", () => {
		// The audit's requirement: an over-budget authored context must not arrive as the same class
		// of failure as a disk that would not open. The message says what is large and by how much.
		const refusal = refuseAuthoredContextOverBudget(SHIPPED, 20_000);
		expect(refusal?.message ?? "").not.toMatch(
			/storage is busy|busy|try again|send your message again/i,
		);
		expect(refusal?.message ?? "").toMatch(/authored context/i);
	});

	test("the refusal carries the numbers as data as well as prose", () => {
		// A caller that wants to render its own sentence (a Host problem code, a UI panel) needs the
		// figures without parsing English.
		const refusal = refuseAuthoredContextOverBudget(SHIPPED, 20_000);
		expect(refusal?.budget).toEqual({
			usableSoft: SHIPPED.usableSoft,
			floorTokens: SHIPPED.floorTokens,
			historyBudgetTokens: SHIPPED.historyBudgetTokens,
			authoredBudgetTokens: SHIPPED_AUTHORED_BUDGET,
			authoredTokens: 20_000,
			inputTokens: SHIPPED.floorTokens + SHIPPED.historyBudgetTokens + 20_000,
			headroomTokens: SHIPPED.usableSoft - FIXED - 20_000,
		});
	});
});

describe("the authored unit is ceil(chars / 4), and under-counting is the safe direction", () => {
	test("it matches the unit every authored budgetTokens already speaks", () => {
		expect(authoredTokensForContent("")).toBe(0);
		expect(authoredTokensForContent("a")).toBe(1);
		expect(authoredTokensForContent("abcd")).toBe(1);
		expect(authoredTokensForContent("abcde")).toBe(2);
	});

	test("CJK is counted at the ASCII rate, so the guard refuses LATE rather than early", () => {
		// This is the direction the doc comment claims. A real tokenizer produces several times more
		// tokens for CJK than chars/4, so an authored total computed this way is a LOWER bound on
		// what the model carries — and a lower bound can only ever admit something that then
		// overflows, never refuse something that would have fitted.
		const cjk = "你好世界星露谷农场";
		expect(authoredTokensForContent(cjk)).toBe(Math.ceil(cjk.length / 4));
		expect(authoredTokensForContent(cjk)).toBeLessThan(cjk.length);
	});
});

describe("a book at the world-book validator's own limits is refused", () => {
	test("one maximal entry already crosses the shipped window", () => {
		// The Host discovered these bounds by asking `validateWorldBook`
		// (`host/src/authored-context-budget.test.ts`): 65,536 characters per entry, 128 entries.
		// A single maximal entry is 16,384 authored tokens against 13,393 of room.
		const oneMaximalEntry = authoredTokensForContent("x".repeat(65_536));
		expect(oneMaximalEntry).toBe(16_384);
		expect(refuseAuthoredContextOverBudget(SHIPPED, oneMaximalEntry)).toBeDefined();
	});

	test("a maximal book is refused by a wide margin, not a near miss", () => {
		const maximalBook = authoredTokensForContent("x".repeat(65_536 * 128));
		expect(maximalBook).toBe(2_097_152);
		const refusal = refuseAuthoredContextOverBudget(SHIPPED, maximalBook);
		expect(refusal).toBeDefined();
		expect(refusal?.budget.headroomTokens).toBe(SHIPPED.usableSoft - FIXED - maximalBook);
	});

	test("the shipped companion's own authored context is nowhere near the bound", () => {
		// The shipped card must never be refused: persona 24 + book 40 + scenario 22 stable, 208
		// volatile — 294 tokens against 13,393. If this ever fails, the product ships a card it
		// cannot run, which is a different problem from the one this guard solves.
		expect(refuseAuthoredContextOverBudget(SHIPPED, 294)).toBeUndefined();
	});
});
