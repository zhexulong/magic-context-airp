import { expect, it } from "bun:test";
import {
	getChannel2NudgeState,
	getTagsBySession,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { getPiChannel1Baseline } from "./ctx-reduce-nudge-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const TAG_PREFIX = /§\d+§/;

/**
 * A host can start a session with `noTools: "all"` plus an explicit allow-list, which leaves
 * `ctx_reduce` out of the set declared to the model. The `§N§` prefix addresses that tool and
 * nothing else, so on such a session it is notation the model reads, copies into its own reply,
 * and the player then reads back. Tag rows are still allocated, because persisted drops replay
 * from them.
 */
it("a session whose tool set has no ctx_reduce gets no §N§ prefixes but keeps its tag rows", async () => {
	const db = createTestDb();
	const sessionId = "pi-ctx-reduce-tool-absent";
	try {
		const { pi, handlers } = createFakePi();
		pi.getActiveTools = () => [];
		registerPiContextHandler(pi as never, { db, protectedTags: 0 });
		const handler = handlers.get("context") as (
			event: { messages: never[] },
			ctx: never,
		) => Promise<{ messages: unknown[] }>;
		const build = () => {
			const messages = [
				userMessage("Good morning.", 1),
				assistantMessage("She nods.", 2),
				userMessage("Did the kettle boil?", 3),
			];
			return { messages, entryIds: messages.map((_, index) => `entry-${index}`) };
		};

		const { messages, entryIds } = build();
		const served = await handler({ messages: messages as never[] }, {
			...fakeContext(sessionId, process.cwd(), entryIds, messages as never),
			getContextUsage: () => ({ tokens: 4000, percent: 4, contextWindow: 100000 }),
		} as never);

		const conversation = served.messages.filter(
			(message) => (message as { role?: unknown }).role !== "system",
		);
		expect(conversation.map((message) => textOf(message as never))).toEqual([
			"Good morning.",
			"She nods.",
			"Did the kettle boil?",
		]);
		expect(JSON.stringify(served.messages)).not.toMatch(TAG_PREFIX);
		expect(getTagsBySession(db, sessionId).length).toBeGreaterThanOrEqual(2);
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
	}
});

it("a session that can call ctx_reduce still gets its §N§ prefixes", async () => {
	const db = createTestDb();
	const sessionId = "pi-ctx-reduce-tool-present";
	try {
		const { pi, handlers } = createFakePi();
		registerPiContextHandler(pi as never, { db, protectedTags: 0 });
		const handler = handlers.get("context") as (
			event: { messages: never[] },
			ctx: never,
		) => Promise<{ messages: unknown[] }>;
		const messages = [userMessage("Good morning.", 1), assistantMessage("She nods.", 2)];
		const entryIds = messages.map((_, index) => `entry-${index}`);
		const served = await handler({ messages: messages as never[] }, {
			...fakeContext(sessionId, process.cwd(), entryIds, messages as never),
			getContextUsage: () => ({ tokens: 4000, percent: 4, contextWindow: 100000 }),
		} as never);

		const conversation = served.messages
			.filter((message) => (message as { role?: unknown }).role !== "system")
			.map((message) => textOf(message as never));
		expect(conversation[0]).toMatch(/^§\d+§ Good morning\.$/);
		expect(conversation[1]).toMatch(/^§\d+§ She nods\.$/);
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
	}
});

/**
 * The `§N§` prefix is only one of two prompts that address `ctx_reduce`. Channel 1 appends
 * a reminder to a tool result and Channel 2 steers a hidden ceiling nudge into the run;
 * both say "call ctx_reduce", so a session that cannot call it must get neither. The
 * baseline is the only signal either delivery path reads, so the pass that would arm
 * them is where the tool verdict belongs.
 */
const toolHeavyMessages = () => [
	userMessage("Dig the soil.", 1),
	assistantToolCall("call-nudge", "stardew_observe", {}, 2),
	toolResultMessage("call-nudge", "word ".repeat(80_000), 3),
];

const runToolHeavyPass = async (input: {
	pi: ReturnType<typeof createFakePi>["pi"];
	handlers: ReturnType<typeof createFakePi>["handlers"];
	sessionId: string;
}) => {
	const messages = toolHeavyMessages();
	return (
		input.handlers.get("context") as (
			event: { messages: never[] },
			ctx: never,
		) => Promise<{ messages: unknown[] }>
	)(
		{ messages: messages as never[] },
		{
			...fakeContext(
				input.sessionId,
				process.cwd(),
				messages.map((_, index) => `entry-${index}`),
				messages as never,
			),
			getContextUsage: () => ({ tokens: 10_000, percent: 5, contextWindow: 200_000 }),
		} as never,
	);
};

it("a session whose tool set has no ctx_reduce arms no ctx_reduce nudge channel", async () => {
	const db = createTestDb();
	const sessionId = "pi-ctx-reduce-tool-absent-nudge";
	try {
		const { pi, handlers } = createFakePi();
		pi.getActiveTools = () => [];
		registerPiContextHandler(pi as never, { db, protectedTags: 0 });

		const served = await runToolHeavyPass({ pi, handlers, sessionId });

		// The pass really did run over reclaimable mass; the reminder channel is what is off.
		expect(getPiChannel1Baseline(sessionId)).toBeUndefined();
		expect(getChannel2NudgeState(db, sessionId)).toBe("");
		expect(JSON.stringify(served.messages)).not.toContain("ctx_reduce");
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
	}
});

it("a session that can call ctx_reduce still arms the ceiling nudge on the same input", async () => {
	const db = createTestDb();
	const sessionId = "pi-ctx-reduce-tool-present-nudge";
	try {
		const { pi, handlers } = createFakePi();
		pi.getActiveTools = () => ["ctx_reduce"];
		registerPiContextHandler(pi as never, { db, protectedTags: 0 });

		await runToolHeavyPass({ pi, handlers, sessionId });

		expect(getPiChannel1Baseline(sessionId)).toBeDefined();
		expect(getChannel2NudgeState(db, sessionId)).toBe("pending");
	} finally {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
	}
});
