/// <reference types="bun-types" />

/**
 * The Pi historian's memory domain has to travel with the rest of the historian configuration.
 *
 * `runPiHistorian` falls back to `"coding-project"` when its `memoryDomain` dependency is missing, and that
 * default chooses the compartment system prompt. So a call site that forwards `memoryEnabled` and `language`
 * but forgets the domain does not fail: the companion's compartments are simply written in the coding voice,
 * with role labels and transcript ordinals in the prose. That is exactly what happened, and it took a real
 * fold plus a rubric run to see it, because nothing in the type system or the tests objected.
 *
 * This pins the forwarding itself. It is a source fence, in the style of the repository's other fences, and
 * it is deliberately narrow: it asserts the one call site passes the domain through.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const CONTEXT_HANDLER = join(
	REPO_ROOT,
	"packages",
	"pi-plugin",
	"src",
	"context-handler.ts",
);
const RUNNER = join(
	REPO_ROOT,
	"packages",
	"pi-plugin",
	"src",
	"pi-historian-runner.ts",
);

describe("the Pi historian call site forwards the memory domain", () => {
	it("passes memoryDomain into runPiHistorian", () => {
		const source = readFileSync(CONTEXT_HANDLER, "utf8");
		const callAt = source.indexOf("await runPiHistorian({");
		expect(callAt).toBeGreaterThan(-1);
		// The call's argument object ends at the next `});` — plenty of room for the fields we assert on.
		const call = source.slice(callAt, source.indexOf("\n\t\t\t\t});", callAt));
		expect(call).toContain("memoryEnabled: historian.memoryEnabled");
		expect(call).toContain("memoryDomain: historian.memoryDomain");
	});

	it("keeps the runner's fallback a coding-project default, not an ongoing one", () => {
		const source = readFileSync(RUNNER, "utf8");
		// If this default ever became "ongoing-interaction", a missing dependency would silently write
		// companion memory for a coding project and the fence above would stop meaning what it says.
		expect(source).toContain('memoryDomain = "coding-project"');
	});
});
