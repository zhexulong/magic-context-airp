/**
 * Whether this host keeps a fire-and-forget background run alive past `agent_end`.
 *
 * Magic Context gates the historian spawn on `ctx.hasUI`, and the reason it records is about lifetime,
 * not about the interface: a headless one-shot Pi exits right after `agent_end` WITHOUT dispatching
 * `session_shutdown`, so a run spawned there is killed mid-flight and its compartment-state lease is
 * never released by the shutdown path. For a terminal Pi the two questions coincide, which is why the
 * UI test survived as a proxy.
 *
 * An embedded host is not the one-shot case. It owns a long-lived process and disposes its session,
 * which dispatches `session_shutdown` - the very signal the plugin's own shutdown path uses to cancel
 * the in-flight run and await its `finally`. Gating such a host on the absence of a UI does not
 * protect anything; it only guarantees the historian never runs, so no compartment is ever created
 * and no chapter can ever be sealed.
 *
 * Such a host declares the capability it actually has with `GAMEBUDDY_EMBEDDED_RUNTIME=1` (the same
 * declaration this package already uses to select the embedded historian runner, so there is one
 * truth about "embedded", not two). The declaration is read on every call and never memoized: a
 * process that flips it between sessions must not inherit a stale answer.
 */
export function hostOutlivesBackgroundRuns(hasUI: boolean): boolean {
	if (hasUI) return true;
	return process.env.GAMEBUDDY_EMBEDDED_RUNTIME === "1";
}
