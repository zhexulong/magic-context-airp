/**
 * Pi-side non-durable runtime environment facts injection — mirrors OpenCode's
 * `injectRuntimeEnvironmentFacts` (packages/plugin/src/hooks/magic-context/
 * runtime-environment-facts.ts).
 *
 * GameBuddy companion surfaces are time/state-driven; the host registers ONE
 * boot-time provider and this pass injects its CURRENT snapshot as an
 * idempotent <runtime-environment> block in the first visible user message.
 * Every pass refreshes the block from the provider, so a weather change or
 * hour advance is visible on the next turn without any memory write. No
 * provider = absent block (upstream behavior unchanged).
 *
 * Pi differences from OpenCode:
 *   - Pi user messages carry `content: string | (TextContent | ImageContent)[]`
 *     instead of OpenCode's `parts`; we mutate the first text content (or
 *     convert a bare string into an array + text content).
 *   - Same idempotency rule: an existing block is REPLACED (never stacked);
 *     a removed provider strips it.
 */

import {
	hasRuntimeEnvironmentFactsProvider,
	injectRuntimeEnvironmentFacts,
	renderRuntimeEnvironmentBlock,
} from "@magic-context/core/hooks/magic-context/runtime-environment-facts";

type PiTextContent = { type: "text"; text: string; textSignature?: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };
type PiUserMessage = {
	role: "user";
	content: string | (PiTextContent | PiImageContent)[];
	timestamp?: number;
};

const ENVIRONMENT_BLOCK_PATTERN =
	/<runtime-environment>[\s\S]*?<\/runtime-environment>/;

/**
 * Inject the current environment block into the first visible Pi user
 * message's text. Returns the number of messages modified (0 or 1).
 * Idempotent by marker: an identical block is left untouched; a changed
 * block replaces the old one; a removed provider strips it.
 */
export function injectPiRuntimeEnvironmentFacts(messages: unknown[]): number {
	const block = renderRuntimeEnvironmentBlock();
	let modified = 0;
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiUserMessage;
		if (msg.role !== "user") continue;
		const content = msg.content;
		if (typeof content === "string") {
			if (block === undefined) {
				if (ENVIRONMENT_BLOCK_PATTERN.test(content)) {
					msg.content = content.replace(ENVIRONMENT_BLOCK_PATTERN, "").replace(/^\s+/, "").replace(/\s+$/, "");
					modified += 1;
				}
			} else if (!ENVIRONMENT_BLOCK_PATTERN.test(content)) {
				msg.content = `${block}\n\n${content}`;
				modified += 1;
			} else {
				// Existing block: replace only if the value changed.
				const existing = content.match(ENVIRONMENT_BLOCK_PATTERN)?.[0];
				if (existing !== block) {
					msg.content = content.replace(ENVIRONMENT_BLOCK_PATTERN, block);
					modified += 1;
				}
			}
			return modified;
		}
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type !== "text") continue;
			if (block === undefined) {
				if (ENVIRONMENT_BLOCK_PATTERN.test(part.text)) {
					part.text = part.text.replace(ENVIRONMENT_BLOCK_PATTERN, "").replace(/^\s+/, "").replace(/\s+$/, "");
					modified += 1;
				}
			} else if (!ENVIRONMENT_BLOCK_PATTERN.test(part.text)) {
				part.text = `${block}\n\n${part.text}`;
				modified += 1;
			} else {
				const existing = part.text.match(ENVIRONMENT_BLOCK_PATTERN)?.[0];
				if (existing !== block) {
					part.text = part.text.replace(ENVIRONMENT_BLOCK_PATTERN, block);
					modified += 1;
				}
			}
			return modified;
		}
	}
	return modified;
}

export {
	hasRuntimeEnvironmentFactsProvider,
} from "@magic-context/core/hooks/magic-context/runtime-environment-facts";