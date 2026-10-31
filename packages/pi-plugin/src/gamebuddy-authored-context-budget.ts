/**
	* The authored half's total bound, checked against the window it has to share.
	*
	* <p>
	* The volatile half of an authored catalogue is summed and refused past
	* `MAX_AUTHORED_VOLATILE_BUDGET_TOKENS` (32,768) in `gamebuddy-stable-context-source`. The STABLE
	* half is injected unconditionally into the cached m[0] head on every turn and had no cross-source
	* bound at all — only a per-source `budgetTokens > 0`. That asymmetry is this module's reason to
	* exist.
	* </p>
	*
	* <p>
	* **Why a total, and not a bigger per-half number.** The Host measured the shipped 32,768/8,192
	* geometry (`host/src/authored-context-budget.test.ts`) and found the point where the prompt stops
	* fitting — floor + history budget + authored == `usableSoft` — at **13,393 authored tokens**. That
	* is BELOW the existing volatile ceiling of 32,768, so a volatile-only bound (or a larger one)
	* cannot bound this: the window runs out before either half's own limit does. The bound therefore
	* has to be a total over the authored half, compared against the window the request actually has.
	* </p>
	*
	* <p>
	* **Why the numbers are passed in rather than resolved here.** The three fixed terms are facts of
	* the assembled request — the system prompt and tool definitions in the envelope, and the history
	* budget the fold will spend in the same head. This module runs at prompt-build time, where those
	* terms are known exactly; the Host measures its own catalogue at publish time, where the window is
	* not. So this module owns the comparison and the refusal, and its caller supplies the terms. A
	* caller that cannot supply them (an older host, a surface with no authored context) gets the
	* comparison skipped rather than a fabricated number: an unknown window is not a reason to refuse a
	* turn that fits.
	* </p>
	*
	* <p>
	* **The authored unit is `ceil(chars / 4)` — an ESTIMATE, and a low one.** It is the unit every
	* `budgetTokens` in this system already speaks, and the unit the volatile sum is bounded in. A flat
	* four-characters-per-token ratio is roughly right for English prose and several times too low for
	* CJK, where a real BPE tokenizer produces more tokens per character. That direction is deliberate
	* and safe: because the authored figure UNDER-counts, this guard refuses slightly LATER than a real
	* token count would — so it never refuses a card that would actually have fitted. The error it can
	* make is to admit an over-size card, which the provider's own overflow path still catches; the
	* error it must not make is to refuse a valid one.
	* </p>
	*/

/** The three fixed terms of the assembled request that authored context competes with. */
export type GameBuddyAuthoredContextWindowFacts = Readonly<{
	/** `usableSoft` for this request's model — the window after the output reserve is carved out. */
	usableSoft: number;
	/** The system prompt plus every tool definition, as one measured envelope. */
	floorTokens: number;
	/** The history budget the fold will spend inside the same head (0 when history is off). */
	historyBudgetTokens: number;
}>;

export type GameBuddyAuthoredContextBudget = Readonly<{
	usableSoft: number;
	floorTokens: number;
	historyBudgetTokens: number;
	/** `usableSoft - floorTokens - historyBudgetTokens`: the most authored text that can fit. */
	authoredBudgetTokens: number;
	authoredTokens: number;
	/** `floorTokens + historyBudgetTokens + authoredTokens` — everything but the transcript. */
	inputTokens: number;
	/** `usableSoft - inputTokens`; negative means this request cannot fit at all. */
	headroomTokens: number;
}>;

export type GameBuddyAuthoredContextBudgetRefusal = Readonly<{
	code: "gamebuddy_authored_context_over_budget";
	message: string;
	budget: GameBuddyAuthoredContextBudget;
}>;

/**
 * The error this module throws, carrying a message meant for the PLAYER.
 *
 * <p>
 * The distinction matters: Magic Context's ordinary refusal path leads with "could not safely
 * prepare this turn; send your message again", which is exactly the wrong advice here — resending
 * changes nothing, because the authored context is the same size every turn. So this error carries
 * `playerMessage`, and the refusal path leads with THAT when it is present. `code` keeps it
 * classifiable for a caller that wants to react (a Host problem code, a test), and `budget` carries
 * the numbers as data so no consumer has to parse English to get them.
 * </p>
 */
export class GameBuddyAuthoredContextOverBudgetError extends Error {
	readonly code = "gamebuddy_authored_context_over_budget";
	readonly playerMessage: string;
	readonly budget: GameBuddyAuthoredContextBudget;

	constructor(refusal: GameBuddyAuthoredContextBudgetRefusal) {
		super(refusal.message);
		this.name = "GameBuddyAuthoredContextOverBudgetError";
		this.playerMessage = refusal.message;
		this.budget = refusal.budget;
	}
}

/**
	* `Math.ceil(content.length / 4)`, the unit every authored `budgetTokens` already speaks.
	*
	* Exported so the caller that materializes sources and this module cannot disagree about it.
	*/
export function authoredTokensForContent(content: string): number {
	return Math.ceil(content.length / 4);
}

function isPositiveFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
	* Whether these facts can support a comparison at all.
	*
	* A window that is absent, zero or not a finite positive number is not evidence that the prompt is
	* too large — it is evidence that this pass cannot answer the question. Refusing on it would turn a
 * cold-start or a test fixture into a broken turn, which is exactly the disguised-failure
 * class this guard exists to end.
	*/
export function canCheckAuthoredContextBudget(
	facts: GameBuddyAuthoredContextWindowFacts | undefined,
): facts is GameBuddyAuthoredContextWindowFacts {
	return (
		facts !== undefined &&
		isPositiveFinite(facts.usableSoft) &&
		Number.isFinite(facts.floorTokens) &&
		facts.floorTokens > 0 &&
		Number.isFinite(facts.historyBudgetTokens) &&
		facts.historyBudgetTokens >= 0
	);
}

/** The arithmetic, without the decision, so a caller can report the numbers it refused on. */
export function computeAuthoredContextBudget(
	facts: GameBuddyAuthoredContextWindowFacts,
	authoredTokens: number,
): GameBuddyAuthoredContextBudget {
	const authoredBudgetTokens = facts.usableSoft - facts.floorTokens - facts.historyBudgetTokens;
	const inputTokens = facts.floorTokens + facts.historyBudgetTokens + authoredTokens;
	return Object.freeze({
		usableSoft: facts.usableSoft,
		floorTokens: facts.floorTokens,
		historyBudgetTokens: facts.historyBudgetTokens,
		authoredBudgetTokens,
		authoredTokens,
		inputTokens,
		headroomTokens: facts.usableSoft - inputTokens,
	});
}

/**
	* The refusal this catalogue earns, or `undefined` when it fits.
	*
	* <p>
	* **What the player reads, and why every clause is there.** The message has to be actionable, so it
	* names the four numbers that decide the answer and the two things a player can actually do:
	* </p>
	* <ul>
	*   <li>their authored size and the budget it exceeded, so "too big" becomes a quantity;</li>
	*   <li>the fixed cost already spent, so the budget is not mistaken for a Host limit pulled out of
 *       nowhere — it is what is left after the system prompt, the tools and the history
 *       budget;</li>
	*   <li>removing entries or splitting the book, which always helps because both shrink the authored
	*       total;</li>
	*   <li>a larger-window model, which is true and is the only action that helps without deleting
	*       anything — the same authored text fits a bigger window, as the Host's own curve shows.</li>
	* </ul>
	* <p>
	* It does NOT say "truncated", "dropped" or "shortened", because nothing is dropped: the whole
	* catalogue is refused rather than silently reduced. Dropping entries would change what the
	* companion knows without telling anyone, which is worse than refusing the turn.
	* </p>
	*/
export function refuseAuthoredContextOverBudget(
	facts: GameBuddyAuthoredContextWindowFacts,
	authoredTokens: number,
): GameBuddyAuthoredContextBudgetRefusal | undefined {
	if (!canCheckAuthoredContextBudget(facts)) return undefined;
	if (!Number.isFinite(authoredTokens) || authoredTokens < 0) return undefined;
	const budget = computeAuthoredContextBudget(facts, authoredTokens);
	if (authoredTokens <= budget.authoredBudgetTokens) return undefined;
	const over = authoredTokens - budget.authoredBudgetTokens;
	const fixed = budget.floorTokens + budget.historyBudgetTokens;
	return Object.freeze({
		code: "gamebuddy_authored_context_over_budget" as const,
		message:
			`This companion's authored context is ${budget.authoredTokens} tokens, and ` +
			`${budget.authoredBudgetTokens} fit in this model's ${budget.usableSoft}-token window ` +
			`once the prompt and tools (${budget.floorTokens}) and the conversation history ` +
			`(${budget.historyBudgetTokens}) are counted — ${over} tokens over. ` +
			`Remove or shorten some world-book entries, split the book into a smaller one for ` +
			`this companion, or switch to a model with a larger context window ` +
			`(${budget.usableSoft} tokens of room now; ${fixed} of it is already spent on the ` +
			`prompt, the tools and the history).`,
		budget,
	});
}
