import { beforeEach, describe, expect, it } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	__resetRuntimeEnvironmentFactsForTesting,
	setRuntimeEnvironmentFacts,
} from "@magic-context/core/hooks/magic-context/runtime-environment-facts";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	registerPiContextHandler,
	signalPiHistoryRefresh,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	userMessage,
} from "./test-utils.test";

describe("pi runtime environment facts across a compartment boundary", () => {
	beforeEach(() => {
		__resetRuntimeEnvironmentFactsForTesting();
	});

	it("keeps the block in the first surviving user message when a fold advances the boundary", async () => {
		const db = createTestDb();
		const sessionId = "ses-env-facts-boundary";
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: {},
			injection: { injectionBudgetTokens: 10_000 },
		});
		const handler = fake.handlers.get("context") as (
			event: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const raw = [
			userMessage("turn one", 1),
			assistantMessage("ack one", 2),
			userMessage("turn two", 3),
			assistantMessage("ack two", 4),
			userMessage("live tail", 5),
		];
		const ids = ["a", "b", "c", "d", "tail"];
		const facts = { weather: "rain" };
		setRuntimeEnvironmentFacts(() => `weather=${facts.weather}`);
		const pass = async () => {
			const messages = structuredClone(raw);
			return handler(
				{ messages },
				{
					...fakeContext(sessionId, process.cwd(), ids, messages as never),
					model: {
						provider: "anthropic",
						id: "claude-sonnet-4",
						contextWindow: 100_000,
					},
				},
			);
		};
		const environmentText = (result: { messages: unknown[] }) =>
			result.messages
				.map((message) => textOf(message as never))
				.find((text) => text.includes("<runtime-environment>"));
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "a",
					endMessageId: "b",
					title: "Covered turn one",
					content: "U: turn one\nA: ack one",
				},
			]);
			// First pass folds the compartment; the trim removes the covered prefix.
			expect(
				environmentText(await pass()) ?? "<no environment block>",
			).toContain("weather=rain");

			// A published compartment advances the boundary, so the trim fires again
			// in the same pass that injected the block.
			facts.weather = "sunny";
			appendCompartments(db, sessionId, [
				{
					sequence: 1,
					startMessage: 3,
					endMessage: 4,
					startMessageId: "c",
					endMessageId: "d",
					title: "Covered turn two",
					content: "U: turn two\nA: ack two",
				},
			]);
			signalPiHistoryRefresh(sessionId);
			const advanced = await pass();
			expect(environmentText(advanced) ?? "<no environment block>").toContain(
				"weather=sunny",
			);
			// The block belongs to the first surviving player turn, never to Magic
			// Context's synthetic history prefix.
			expect(environmentText(advanced)).toContain("live tail");
			expect(
				(advanced.messages as { role?: string }[]).every(
					(message) =>
						message.role !== "user" ||
						!textOf(message as never).startsWith("<session-history>") ||
						!textOf(message as never).includes("<runtime-environment>"),
				),
			).toBe(true);
		} finally {
			__resetRuntimeEnvironmentFactsForTesting();
			closeQuietly(db);
		}
	});
});
