/**
 * Non-durable runtime environment facts.
 *
 * GameBuddy companion surfaces are time-and-state driven: the game world is
 * at a particular hour, season, weather, location. Those facts are REAL and
 * current, but they are deliberately NOT player memories — writing today's
 * rain into the durable memory store would make past and present weather
 * indistinguishable to the renderer and pollute the player-managed store.
 *
 * The host registers a PROVIDER at boot time (locked, like setHarness) and the
 * transform pass injects the provider's CURRENT snapshot as a bounded,
 * idempotent, non-durable block in prompts. Every pass refreshes the block
 * from the provider, so a weather change or hour advance is visible to the
 * model on the next turn without any memory write. Without a provider the
 * block is absent (upstream behavior unchanged).
 *
 * Mirrors injectTemporalMarkers: runs every pass, idempotent by marker,
 * never stacked. The one difference: the value comes from live host state
 * instead of immutable message timestamps.
 */

const ENVIRONMENT_BLOCK_PREFIX = "<runtime-environment>";
const ENVIRONMENT_BLOCK_SUFFIX = "</runtime-environment>";
const ENVIRONMENT_BLOCK_PATTERN =
	/<runtime-environment>[\s\S]*?<\/runtime-environment>/;

type EnvironmentFactsProvider = () => string;

let registeredProvider: EnvironmentFactsProvider | undefined;

/** Boot-time, locked registration. A second provider throws instead of silently replacing. */
export function setRuntimeEnvironmentFacts(
	provider: EnvironmentFactsProvider | undefined,
): void {
	if (provider !== undefined && registeredProvider !== undefined)
		throw new Error("runtime_environment_facts_provider_already_registered");
	registeredProvider = provider;
}

export function hasRuntimeEnvironmentFactsProvider(): boolean {
	return registeredProvider !== undefined;
}

export function renderRuntimeEnvironmentBlock(): string | undefined {
	const provider = registeredProvider;
	if (provider === undefined) return undefined;
	return `${ENVIRONMENT_BLOCK_PREFIX}\n${provider()}\n${ENVIRONMENT_BLOCK_SUFFIX}`;
}

/**
 * Injects the current environment block into the first visible user-message
 * text part, replacing any previous block so repeated passes stay idempotent.
 * Returns the number of messages modified (0 or 1).
 */
export function injectRuntimeEnvironmentFacts(messages: unknown[]): number {
	const block = renderRuntimeEnvironmentBlock();
	let modified = 0;
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		if ((raw as { info?: { role?: unknown } }).info?.role !== "user") continue;
		const parts = (raw as { parts?: unknown }).parts;
		if (!Array.isArray(parts)) continue;
		for (const part of parts) {
			if (
				typeof part !== "object" ||
				part === null ||
				(part as { type?: unknown }).type !== "text"
			)
				continue;
			const candidate = part as {
				text?: unknown;
				ignored?: unknown;
			};
			if (typeof candidate.text !== "string" || candidate.ignored === true)
				continue;
			const hadBlock = ENVIRONMENT_BLOCK_PATTERN.test(candidate.text);
			const stripped = candidate.text.replace(ENVIRONMENT_BLOCK_PATTERN, "");
			if (block === undefined) {
				if (hadBlock) {
					candidate.text = trimmedEmpty(stripped).value;
					modified += 1;
				}
				continue;
			}
			if (!hadBlock) {
				candidate.text = insertBlock(stripped, block);
				modified += 1;
			} else {
				// Same block (by exact marker boundary and content) → idempotent no-op.
				const existing = candidate.text.match(ENVIRONMENT_BLOCK_PATTERN)?.[0];
				if (existing !== block) {
					candidate.text = insertBlock(stripped, block);
					modified += 1;
				}
			}
			return modified;
		}
	}
	return modified;
}

function insertBlock(text: string, block: string): string {
	const leading = /^(\s*)/.exec(text)?.[1] ?? "";
	const trailing = /(\s*)$/.exec(text)?.[1] ?? "";
	const body = text.trim();
	const separator = body.length > 0 ? "\n\n" : "";
	return `${leading}${block}${separator}${body}${trailing}`;
}

function trimmedEmpty(value: string): { value: string } {
	return { value: value.replace(/^\s+/, "").replace(/\s+$/, "") };
}

/** Test-only reset; production never calls this. */
export function __resetRuntimeEnvironmentFactsForTesting(): void {
	registeredProvider = undefined;
}