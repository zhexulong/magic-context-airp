/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	authoredTokensForContent,
	GameBuddyAuthoredContextOverBudgetError,
	refuseAuthoredContextOverBudget,
} from "./gamebuddy-authored-context-budget";
import { contextHost } from "./pi-context-host.test";
import { registerPiGuardedContext } from "./pi-context-refusal";

/**
 * THE REFUSAL A PLAYER READS WHEN THEIR OWN CONTEXT IS TOO LARGE.
 *
 * <p>
 * The audit's requirement, asserted at the seam that produces the message: an over-budget authored
 * context must not reach the player as `raw_fallback_over_context_limit` / `PiStorageBusyError`,
 * which is indistinguishable from a disk that would not open. It has to arrive as a sentence that
 * names the authored budget and tells them what to do about it.
 * </p>
 *
 * <p>
 * The refusal path is driven through the REAL installed Pi runner (`contextHost`), not a copy of
 * its exception handling, so what these tests read is the string the player would actually see.
 * </p>
 */

const SHIPPED = Object.freeze({
	usableSoft: 24_576,
	floorTokens: 8_787,
	historyBudgetTokens: 2_396,
});

const CTX = {} as ExtensionContext;
const RAW = [{ role: "user", content: "hello", timestamp: 1 }];

/** Register a handler that always throws `reason`, and drive one context pass through Pi. */
async function refusedTurn(reason: unknown) {
	const host = contextHost();
	// The guarded handler is what `registerPiGuardedContext` installs on `pi.on("context")`, so the
	// fake pi must COLLECT it — emitting the raw throwing handler instead would bypass the refusal
	// path entirely and assert nothing about the message.
	const registered: Array<(...args: never[]) => unknown> = [];
	const pi = {
		...host.api,
		on(event: string, handler: (...args: never[]) => unknown) {
			if (event === "context") registered.push(handler);
		},
	};
	const handler = async () => {
		throw reason;
	};
	registerPiGuardedContext(pi as never, handler as never);
	expect(registered).toHaveLength(1);
	const served = await host.emit(registered[0] as never, RAW, CTX);
	return { host, served };
}

/** The single refusal entry's message. */
function refusalMessage(host: ReturnType<typeof contextHost>): string {
	expect(host.entries).toHaveLength(1);
	const data = host.entries[0]?.data as { message?: string } | undefined;
	expect(typeof data?.message).toBe("string");
	return data?.message ?? "";
}

const REFUSAL = refuseAuthoredContextOverBudget(SHIPPED, 20_000);

describe("an over-budget authored context reaches the player as its own sentence", () => {
	it("the sentence leads the message, instead of the retry advice", async () => {
		expect(REFUSAL).toBeDefined();
		if (REFUSAL === undefined) return;
		const { host, served } = await refusedTurn(new GameBuddyAuthoredContextOverBudgetError(REFUSAL));
		const message = refusalMessage(host);
		// The whole point: the actionable sentence comes FIRST.
		expect(message).toStartWith("This companion's authored context is");
		// And the numbers a player needs are in it.
		expect(message).toContain("20000");
		expect(message).toContain("13393");
		expect(message).toContain("24576");
		// The generic advice must not be the lead. It is not merely unhelpful here, it is wrong:
		// resending changes nothing because the card is the same size every turn.
		expect(message).not.toStartWith("Magic Context could not safely prepare this turn");
		// The turn is still aborted and the pristine messages are still what Pi would have sent.
		expect(host.controller.signal.aborted).toBe(true);
		expect(served).toEqual(RAW);
	});

	it("it does not read as a storage failure or a transient fault", async () => {
		if (REFUSAL === undefined) return;
		const { host } = await refusedTurn(new GameBuddyAuthoredContextOverBudgetError(REFUSAL));
		const message = refusalMessage(host);
		expect(message).not.toMatch(/storage is busy|raw_fallback|over_context_limit|PI_STORAGE_BUSY/i);
		expect(message).not.toMatch(/send your message again/i);
	});

	it("an ordinary transient failure still leads with the retry advice", async () => {
		// The counterpart, so the new branch cannot swallow the old one: a cause with no
		// `playerMessage` keeps the existing wording exactly.
		const { host } = await refusedTurn(new Error("some transient thing"));
		expect(refusalMessage(host)).toStartWith(
			"Magic Context could not safely prepare this turn; send your message again.",
		);
	});

	it("a playerMessage buried behind a wrapper cause is still found", async () => {
		// The failure may arrive wrapped (a caller's own error with `cause` set). The refusal path
		// walks the chain rather than requiring the error to be the outer object.
		if (REFUSAL === undefined) return;
		const wrapped = new Error("wrapper", {
			cause: new GameBuddyAuthoredContextOverBudgetError(REFUSAL),
		});
		const { host } = await refusedTurn(wrapped);
		expect(refusalMessage(host)).toStartWith("This companion's authored context is");
	});
});

describe("the error carries the numbers as data for a Host that renders its own sentence", () => {
	it("code, budget and playerMessage are all present", () => {
		expect(REFUSAL).toBeDefined();
		if (REFUSAL === undefined) return;
		const error = new GameBuddyAuthoredContextOverBudgetError(REFUSAL);
		expect(error.code).toBe("gamebuddy_authored_context_over_budget");
		expect(error.name).toBe("GameBuddyAuthoredContextOverBudgetError");
		expect(error.budget.authoredTokens).toBe(20_000);
		expect(error.budget.authoredBudgetTokens).toBe(13_393);
		expect(error.playerMessage).toBe(REFUSAL.message);
		// `message` is the same sentence, so a caller that logs the error gets the numbers too.
		expect(error.message).toBe(REFUSAL.message);
	});
});

describe("the authored total the handler measures is the sum of both halves", () => {
	it("stable and volatile sources are counted with the one shared unit", () => {
		// The handler sums `materialization.sources` and `materialization.volatileSources` with
		// `authoredTokensForContent`. This pins the unit those sums use to the one the bound speaks,
		// so the two cannot drift into different arithmetic.
		const contents = ["A quiet tavern.", "x".repeat(400), "你好世界"];
		const total = contents.reduce((sum, content) => sum + authoredTokensForContent(content), 0);
		expect(total).toBe(contents.reduce((sum, content) => sum + Math.ceil(content.length / 4), 0));
	});
});
