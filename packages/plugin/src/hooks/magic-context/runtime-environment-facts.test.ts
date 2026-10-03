import { describe, expect, it, beforeEach } from "vitest";
import {
	__resetRuntimeEnvironmentFactsForTesting,
	hasRuntimeEnvironmentFactsProvider,
	injectRuntimeEnvironmentFacts,
	renderRuntimeEnvironmentBlock,
	setRuntimeEnvironmentFacts,
} from "./runtime-environment-facts";

function userMessage(
	text: string,
	options: { ignored?: boolean; role?: string } = {},
): Record<string, unknown> {
	const parts: Record<string, unknown>[] = [
		{ type: "text", text, ...(options.ignored === true ? { ignored: true } : {}) },
	];
	return { info: { role: options.role ?? "user" }, parts };
}

function systemMessage(): Record<string, unknown> {
	return { info: { role: "system" }, parts: [{ type: "text", text: "sys" }] };
}

describe("runtime environment facts", () => {
	beforeEach(() => {
		__resetRuntimeEnvironmentFactsForTesting();
	});

	it("injects a non-durable block into the first visible user message", () => {
		setRuntimeEnvironmentFacts(() => "hour=1800 season=spring weather=rain");
		const messages = [systemMessage(), userMessage("hello")];
		const modified = injectRuntimeEnvironmentFacts(messages);
		expect(modified).toBe(1);
		const text = (messages[1] as { parts: { text: string }[] }).parts[0].text as string;
		expect(text).toMatch(/<runtime-environment>/);
		expect(text).toContain("hour=1800 season=spring weather=rain");
		expect(text).toContain("</runtime-environment>");
		expect(text).toContain("hello");
	});

	it("is idempotent across passes and refreshes the value", () => {
		let weather = "rain";
		setRuntimeEnvironmentFacts(() => `weather=${weather}`);
		const messages = [userMessage("harvest the field")];

		expect(injectRuntimeEnvironmentFacts(messages)).toBe(1);
		const first = (messages[0] as { parts: { text: string }[] }).parts[0].text as string;
		expect(first).toMatch(/weather=rain/);

		// Second pass same value: no change, no stacking.
		expect(injectRuntimeEnvironmentFacts(messages)).toBe(0);

		// Weather advanced: the block is REPLACED, not stacked.
		weather = "sunny";
		expect(injectRuntimeEnvironmentFacts(messages)).toBe(1);
		const second = (messages[0] as { parts: { text: string }[] }).parts[0].text as string;
		expect(second).not.toMatch(/weather=rain/);
		expect(second).toMatch(/weather=sunny/);
		expect(second.match(/<runtime-environment>/g)).toHaveLength(1);
	});

	it("skips ignored parts and non-text parts", () => {
		setRuntimeEnvironmentFacts(() => "weather=snow");
		const messages = [userMessage("raw", { ignored: true }), userMessage("visible")];
		expect(injectRuntimeEnvironmentFacts(messages)).toBe(1);
		const visible = (messages[1] as { parts: { text: string }[] }).parts[0].text as string;
		expect(visible).toContain("weather=snow");
	});

	it("does nothing without a registered provider", () => {
		const messages = [userMessage("plain")];
		expect(hasRuntimeEnvironmentFactsProvider()).toBe(false);
		expect(renderRuntimeEnvironmentBlock()).toBeUndefined();
		expect(injectRuntimeEnvironmentFacts(messages)).toBe(0);
	});

	it("strips a stale block when the provider is removed", () => {
		setRuntimeEnvironmentFacts(() => "weather=rain");
		const messages = [userMessage("hello")];
		injectRuntimeEnvironmentFacts(messages);
		__resetRuntimeEnvironmentFactsForTesting();
		expect(injectRuntimeEnvironmentFacts(messages)).toBe(1);
		const text = (messages[0] as { parts: { text: string }[] }).parts[0].text as string;
		expect(text).not.toMatch(/<runtime-environment>/);
		expect(text).toBe("hello");
	});

	it("rejects a second provider (boot-time lock)", () => {
		setRuntimeEnvironmentFacts(() => "weather=rain");
		expect(() => setRuntimeEnvironmentFacts(() => "weather=sunny")).toThrow(
			/runtime_environment_facts_provider_already_registered/,
		);
	});

	it("provides a bounded block (provider content is single-pass snapshot)", () => {
		setRuntimeEnvironmentFacts(() => "location=Farm hour=1400 day=Spring 19 rain");
		const block = renderRuntimeEnvironmentBlock();
		expect(block).toBeDefined();
		expect(block!.length).toBeLessThan(512);
	});
});