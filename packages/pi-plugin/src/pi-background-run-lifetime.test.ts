import { afterEach, describe, expect, it } from "bun:test";
import { hostOutlivesBackgroundRuns } from "./pi-background-run-lifetime";

const prior = process.env.GAMEBUDDY_EMBEDDED_RUNTIME;

function setEmbedded(value: string | undefined): void {
	if (value === undefined) delete process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
	else process.env.GAMEBUDDY_EMBEDDED_RUNTIME = value;
}

afterEach(() => {
	setEmbedded(prior);
});

describe("hostOutlivesBackgroundRuns", () => {
	it("accepts an interactive host without consulting the declaration", () => {
		setEmbedded(undefined);
		expect(hostOutlivesBackgroundRuns(true)).toBe(true);
	});

	it("refuses a headless host that has not declared a longer lifetime", () => {
		// The one-shot case the original `hasUI` gate exists for: the process ends without
		// dispatching session_shutdown, so a fire-and-forget historian would be killed mid-flight and
		// never release its compartment-state lease.
		setEmbedded(undefined);
		expect(hostOutlivesBackgroundRuns(false)).toBe(false);
		// Any other value is not a declaration either - only the exact marker counts.
		setEmbedded("0");
		expect(hostOutlivesBackgroundRuns(false)).toBe(false);
		setEmbedded("true");
		expect(hostOutlivesBackgroundRuns(false)).toBe(false);
	});

	it("accepts a headless host that declares it outlives background runs", () => {
		// The embedded Host: no UI, but it owns the process and disposes the session, so
		// session_shutdown is dispatched and the shutdown path can cancel and await the run.
		setEmbedded("1");
		expect(hostOutlivesBackgroundRuns(false)).toBe(true);
	});

	it("reads the declaration on every call rather than memoizing it", () => {
		setEmbedded(undefined);
		expect(hostOutlivesBackgroundRuns(false)).toBe(false);
		setEmbedded("1");
		expect(hostOutlivesBackgroundRuns(false)).toBe(true);
		setEmbedded(undefined);
		expect(hostOutlivesBackgroundRuns(false)).toBe(false);
	});
});
