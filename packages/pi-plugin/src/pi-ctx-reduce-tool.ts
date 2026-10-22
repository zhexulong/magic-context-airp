import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The tool a `§N§` prefix addresses. */
export const CTX_REDUCE_TOOL_NAME = "ctx_reduce";

/**
 * Whether the model can call `ctx_reduce` in this session.
 *
 * Magic Context registers the tool, but a host may start a session with an explicit
 * allow-list (`noTools: "all"` plus a list) that filters it out. `pi.getActiveTools()` is
 * the set actually declared to the model, so a session without the tool there cannot
 * address a `§N§` prefix: the prefix is notation the model reads, copies into its own
 * reply, and the player then reads back.
 *
 * A double that omits the accessor keeps the historical verdict: Pi's primary process
 * carries the tool.
 */
export function isPiCtxReduceToolActive(
	pi: Pick<Partial<ExtensionAPI>, "getActiveTools">,
): boolean {
	if (typeof pi.getActiveTools !== "function") return true;
	return pi.getActiveTools().includes(CTX_REDUCE_TOOL_NAME);
}
