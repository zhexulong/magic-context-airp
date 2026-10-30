import { describe, expect, it } from "bun:test";
import {
	appendPostHistoryInstructions,
	MAX_POST_HISTORY_INSTRUCTIONS_BYTES,
	renderPostHistoryInstructions,
} from "./post-history-instructions-pi";
import {
	assistantMessage,
	type PiMessage,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const INSTRUCTIONS = "收束时只说一句家常话，别把镜头拉到旁白。";

/** A directive of the shape cards actually carry: each line binds a different behaviour. */
const AUTHOR_DIRECTIVE = [
	"日常相处保持松弛的生活烟火气；",
	"动作采用第一人称具身体感，严禁第三人称小说旁白与摄影机视角的自我描摹；",
	"短促寒暄就短促地答，不要堆成长段；",
	"称谓用“你”；以自然的生活行动或环境细节收束。",
].join("\n");

/**
 * The frame's own characters: the block minus its two tags, its four newlines, and the
 * author's prose. Derived rather than counted by hand, so a frame that grew shows up as a
 * number this suite compares against the direction it wraps.
 */
function frameSize(block: string, instructions: string): number {
	const tags =
		"<character-closing-direction>".length +
		"</character-closing-direction>".length;
	return block.length - instructions.length - tags - 4;
}

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

	it("names the direction as her author's, addressed to her, and licenses nothing", () => {
		const text = renderPostHistoryInstructions(INSTRUCTIONS);
		expect(text).toContain("Your author's direction for how you answer.");
		// The shipped card fixes pronouns, sentence length and what may not appear. A frame
		// that called the words hers to choose would contradict that card from the strongest
		// position in the request, so the frame offers no permission at all.
		const opening = text.slice(
			text.indexOf("\n") + 1,
			text.indexOf(`\n${INSTRUCTIONS}\n`),
		);
		expect(opening).toBe("Your author's direction for how you answer.");
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
	});

	it("does not narrow a multi-line author directive to its last line", () => {
		// A card's `post_history_instructions` is a performance contract: narration in first
		// person, embodied action prose, pacing, the word for the player, and only then how a
		// reply lands. A frame scoped to "the ending" would demote every earlier line to
		// advice she may drop, so the opening must speak to how she answers as a whole.
		const text = renderPostHistoryInstructions(AUTHOR_DIRECTIVE);
		expect(AUTHOR_DIRECTIVE.split("\n")).toHaveLength(4);
		expect(text).toContain(AUTHOR_DIRECTIVE);
		// The envelope tag is not prose; the assertion is about the words the frame speaks.
		const frame = text.slice(
			text.indexOf("\n"),
			text.indexOf(AUTHOR_DIRECTIVE),
		);
		expect(frame).not.toMatch(/\bend(s|ing)?\b/i);
		expect(frame).not.toMatch(/\bclos(e|es|ing)\b/i);
	});

	it("keeps the floor binding in one clause, with no tie-break to weigh the two sides", () => {
		const text = renderPostHistoryInstructions(INSTRUCTIONS);
		// One clause: a second clause would have to say which side wins, and the point of the
		// scope line is that the question never arises.
		expect(text).toContain(
			`\n${INSTRUCTIONS}\nNothing here overrides what already holds.\n</character-closing-direction>`,
		);
	});

	it("spends fewer characters on the frame than the author spent on the direction", () => {
		// The block's last position is the strongest in the request, so every character the
		// frame takes there is a character the author did not write.
		const block = renderPostHistoryInstructions(AUTHOR_DIRECTIVE);
		const frame = frameSize(block, AUTHOR_DIRECTIVE);
		expect(frame).toBeLessThanOrEqual(110);
		expect(frame).toBeLessThan(AUTHOR_DIRECTIVE.length);
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
