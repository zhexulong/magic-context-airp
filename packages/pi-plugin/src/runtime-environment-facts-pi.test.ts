import { describe, expect, it, beforeEach } from "vitest";
import {
	__resetRuntimeEnvironmentFactsForTesting,
	setRuntimeEnvironmentFacts,
} from "@magic-context/core/hooks/magic-context/runtime-environment-facts";
import {
	hasRuntimeEnvironmentFactsProvider,
	injectPiRuntimeEnvironmentFacts,
} from "./runtime-environment-facts-pi";

function userString(text: string): Record<string, unknown> {
	return { role: "user", content: text };
}

function userParts(parts: Record<string, unknown>[]): Record<string, unknown> {
	return { role: "user", content: parts };
}

function assistantMessage(text: string): Record<string, unknown> {
	return { role: "assistant", content: text };
}

describe("pi runtime environment facts", () => {
	beforeEach(() => {
		__resetRuntimeEnvironmentFactsForTesting();
	});

	it("injects into a bare-string user message idempotently and refreshes", () => {
		let weather = "rain";
		setRuntimeEnvironmentFacts(() => `weather=${weather}`);
		const messages = [assistantMessage("hi"), userString("harvest the field")];

		expect(injectPiRuntimeEnvironmentFacts(messages)).toBe(1);
		const first = (messages[1] as { content: string }).content as string;
		expect(first).toMatch(/<runtime-environment>/);
		expect(first).toContain("weather=rain");
		expect(first).toContain("harvest the field");

		// Same value: untouched (idempotent by marker).
		expect(injectPiRuntimeEnvironmentFacts(messages)).toBe(0);

		// Value changed: replaced, never stacked.
		weather = "sunny";
		expect(injectPiRuntimeEnvironmentFacts(messages)).toBe(1);
		const second = (messages[1] as { content: string }).content as string;
		expect(second).not.toContain("weather=rain");
		expect(second).toContain("weather=sunny");
		expect(second.match(/<runtime-environment>/g)).toHaveLength(1);
	});

	it("injects into the first text part of an array content", () => {
		setRuntimeEnvironmentFacts(() => "hour=1800 season=spring");
		const messages = [userParts([{ type: "image", data: "x", mimeType: "png" }, { type: "text", text: "go" }])];
		expect(injectPiRuntimeEnvironmentFacts(messages)).toBe(1);
		const parts = (messages[0] as { content: Record<string, unknown>[] }).content;
		const text = parts.find((p) => p.type === "text") as { text: string };
		expect(text.text).toMatch(/<runtime-environment>/);
		expect(text.text).toContain("hour=1800");
	});

	it("strips when the provider is removed", () => {
		setRuntimeEnvironmentFacts(() => "weather=rain");
		const messages = [userString("hello")];
		injectPiRuntimeEnvironmentFacts(messages);
		__resetRuntimeEnvironmentFactsForTesting();
		expect(injectPiRuntimeEnvironmentFacts(messages)).toBe(1);
		const text = (messages[0] as { content: string }).content as string;
		expect(text).not.toContain("<runtime-environment>");
		expect(text).toBe("hello");
	});

	it("does nothing without a provider", () => {
		const messages = [userString("plain")];
		expect(hasRuntimeEnvironmentFactsProvider()).toBe(false);
		expect(injectPiRuntimeEnvironmentFacts(messages)).toBe(0);
	});
});