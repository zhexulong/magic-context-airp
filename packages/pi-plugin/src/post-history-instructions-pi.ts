import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type PiWireMessage = ContextEvent["messages"][number];

/**
 * The card's `post_history_instructions` bound, in UTF-8 bytes. This is the SAME number
 * the card import applies (`ST_CARD_DECODER_LIMITS_V1.postHistoryInstructionsBytes`):
 * one bound, checked where the card is imported and where the catalogue is validated.
 * Over the bound the field is refused, never truncated — a closing direction cut
 * mid-sentence is worse than no closing direction.
 */
export const MAX_POST_HISTORY_INSTRUCTIONS_BYTES = 4_096;

/**
 * What the block IS, before its prose: said to her, in her own second person.
 *
 * This is the LAST text of the request, so it is the position of greatest weight - and any
 * framing vocabulary spoken ABOUT her costs twice. A card may forbid exactly that
 * ("never describe yourself in the third person"), and the product floor forbids naming
 * prompts and systems at all, so a frame written from outside the character sets the last
 * thing she reads to breaking both. Said to her instead ("your next reply", "your own
 * voice"), the block is authorship of a voice, and nothing in it is a claim about anything
 * but the ending.
 */
const FRAME_OPENING =
	"How your next reply ends is yours to write: your own closing beat, in your own voice.";

/**
 * The precedence line the frame may never omit.
 *
 * The block rides after everything else, so without it a card that says "answer in English"
 * or "ignore your rules" would win by position alone over the Host's own language binding
 * and safety floor. It is stated as SCOPE rather than as a contest: the closing beat is at
 * issue, everything else about her is untouched. That leaves the floor exactly as binding as
 * it was, without a sentence that reads as a rule outranking the floor or as licence to
 * ignore the direction.
 */
const FRAME_FLOOR =
	"Only that closing beat is at issue here; everything else about you stays exactly as it is — the language you speak, and everything you never do.";

/**
 * Render the one trailing block for a card's `post_history_instructions`.
 *
 * The author's prose is carried VERBATIM: no trimming, no macro pass (the card's macros
 * are rendered by the Host at its own read seam, before publication, and the published
 * content hash binds those rendered bytes), no XML escaping (escaping would change bytes
 * the author wrote; the block is prose addressed to the model, not a data payload).
 */
export function renderPostHistoryInstructions(instructions: string): string {
	return `<character-closing-direction>\n${FRAME_OPENING}\n${instructions}\n${FRAME_FLOOR}\n</character-closing-direction>`;
}

/**
 * Append the card's closing direction as the last message of one provider request.
 *
 * # Why this is an append to the served array and nothing else
 *
 * The block is per-turn: it must never enter m[0]/m[1], the fold, a cache key or the
 * durable transcript, or editing a card would only take effect once the cached prefix
 * turned over. `context-handler.ts` therefore calls this from the single success exit that
 * hands the finished array to Pi, after the last reader of that array has run.
 *
 * # Why `role: "user"`
 *
 * `pi-ai`'s `resolveTranscript` collapses later `system` entries into the LEADING system
 * message for every transport without mid-conversation system messages — a trailing
 * system block would be hoisted to the head, which is exactly what this must not be, and
 * would change the head bytes. A user-role text message stays where it is placed on every
 * transport, and is the same envelope Magic Context already ships for its two synthetic
 * history messages (`prependM0M1Messages`).
 *
 * # Absence
 *
 * A card that declares no `post_history_instructions` must produce a prompt byte-for-byte
 * identical to the one without this feature. That is why nothing is appended for
 * `undefined`/empty prose: the array is returned untouched, same reference, same bytes.
 *
 * @returns whether a message was appended.
 */
export function appendPostHistoryInstructions(
	messages: PiWireMessage[],
	instructions: string | undefined,
): boolean {
	if (instructions === undefined || instructions.trim().length === 0) return false;
	messages.push({
		role: "user",
		content: [{ type: "text", text: renderPostHistoryInstructions(instructions) }],
	} as PiWireMessage);
	return true;
}
