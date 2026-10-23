import { describe, expect, it } from "bun:test";
import {
	appendPostHistoryInstructions,
	MAX_POST_HISTORY_INSTRUCTIONS_BYTES,
	renderPostHistoryInstructions,
} from "./post-history-instructions-pi";
import {
	assistantMessage,
	textOf,
	toolResultMessage,
	userMessage,
	type PiMessage,
} from "./test-utils.test";

const INSTRUCTIONS = "收束时只说一句家常话，别把镜头拉到旁白。";

function wire(): PiMessage[] {
	return [
		{ role: "system", content: "system prompt" } as PiMessage,
		userMessage("早上好", 1),
		assistantMessage("早。今天想做什么？", 2),
		userMessage("去镇上买点种子", 3),
	];
}

describe("appendPostHistoryInstructions", () => {
	it("appends exactly one framed message as the last block, with the prose verbatim", () => {
		const messages = wire();
		const before = messages.length;
		expect(appendPostHistoryInstructions(messages, INSTRUCTIONS)).toBe(true);
		expect(messages).toHaveLength(before + 1);
		const tail = messages.at(-1);
		expect(tail?.role).toBe("user");
		const text = textOf(tail);
		expect(text).toContain(INSTRUCTIONS);
		expect(text).toBe(renderPostHistoryInstructions(INSTRUCTIONS));
		expect(text).toStartWith("<character-closing-direction>");
		expect(text).toEndWith("</character-closing-direction>");
		// Exactly one occurrence: the prose is not duplicated into the frame.
		expect(text.split(INSTRUCTIONS)).toHaveLength(2);
	});

	it("frames the block as the close of her own next beat, addressed to her", () => {
		const text = renderPostHistoryInstructions(INSTRUCTIONS);
		expect(text).toContain("How your next reply ends is yours to write");
		// The last text of the request may not describe her from outside: a card may forbid
		// third-person self-description, and the floor forbids naming prompts and systems.
		const frame = text.slice(0, text.indexOf(INSTRUCTIONS));
		for (const forbidden of [
			/\bshe\b/i,
			/\bher\b/i,
			/\bhers\b/i,
			/policy/i,
			/runtime/i,
			/transcript/i,
			/prompt/i,
			/instruction/i,
			/system/i,
		])
			expect(frame).not.toMatch(forbidden);
		// The precedence line is what stops a last-block card from talking over the floor, and
		// it states SCOPE rather than a contest, so it cannot read as outranking the floor.
		expect(text).toContain("Only that closing beat is at issue here");
		expect(text).toContain("the language you speak");
		expect(text).toContain("everything you never do");
	});

	it("is a byte-identical no-op when the card declares nothing", () => {
		const messages = wire();
		const bytes = JSON.stringify(messages);
		const reference = messages;
		expect(appendPostHistoryInstructions(messages, undefined)).toBe(false);
		expect(appendPostHistoryInstructions(messages, "")).toBe(false);
		expect(appendPostHistoryInstructions(messages, "   \n ")).toBe(false);
		expect(messages).toBe(reference);
		expect(JSON.stringify(messages)).toBe(bytes);
	});

	it("does not disturb an existing tool-call tail: it stays the last message", () => {
		const messages: PiMessage[] = [
			userMessage("帮我看看这块地", 1),
			assistantMessage("我看看。", 2),
			toolResultMessage("call-1", "空地", 3),
		];
		appendPostHistoryInstructions(messages, INSTRUCTIONS);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
		expect(textOf(messages.at(-1))).toContain(INSTRUCTIONS);
	});

	it("keeps the card's prose byte-for-byte, including its own markup", () => {
		const authored = "  说完就停。<note>不要总结</note>  ";
		const text = renderPostHistoryInstructions(authored);
		expect(text).toContain(authored);
	});

	it("shares one 4 KB bound with the card import", () => {
		expect(MAX_POST_HISTORY_INSTRUCTIONS_BYTES).toBe(4_096);
	});
});
