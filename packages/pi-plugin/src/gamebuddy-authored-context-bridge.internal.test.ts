import { describe, expect, it } from "bun:test";
import { publishGameBuddyAuthoredStableCatalog } from "./gamebuddy-authored-context-bridge.internal";
import { __gamebuddyReadAuthoredVolatileMaterialization } from "./gamebuddy-stable-context-source";
import { createHash } from "node:crypto";

const scope = { continuityId: "c", sessionId: "s", surface: "tavern" as const, threadId: "t", profile: { profileId: "p", revision: 1, canonicalHash: "a".repeat(64) } };
const content = "The harbor is quiet.";
const source = { sourceId: "lore", kind: "lorebook_constant" as const, revision: "1", content, canonicalHash: createHash("sha256").update(content).digest("hex"), budgetTokens: 5, totalOrderKey: "0001", provenance: "fixture" };
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
const catalog = () => { const body = { version: "gamebuddy-authored-context-catalog/v2" as const, scope, stableSources: [source] }; return { ...body, canonicalHash: createHash("sha256").update(canonical(body)).digest("hex") }; };

describe("authored context private bridge", () => {
  it("supersedes old capabilities without allowing them to clear the replacement", async () => {
    const oldCapability = publishGameBuddyAuthoredStableCatalog(scope, catalog());
    const oldPlan = oldCapability.prepare("preflight_old");
    const replacementContent = "The harbor is busy.";
    const replacementSource = {
      ...source,
      revision: "2",
      content: replacementContent,
      canonicalHash: createHash("sha256").update(replacementContent).digest("hex"),
    };
    const replacementBody = {
      version: "gamebuddy-authored-context-catalog/v2" as const,
      scope,
      stableSources: [replacementSource],
    };
    const replacement = {
      ...replacementBody,
      canonicalHash: createHash("sha256")
        .update(canonical(replacementBody))
        .digest("hex"),
    };
    const newCapability = publishGameBuddyAuthoredStableCatalog(scope, replacement);
    const newPlan = newCapability.prepare("preflight_new");

    expect(() => oldCapability.prepare("preflight_stale")).toThrow(
      "gamebuddy_authored_context_stale_superseded",
    );
    expect(() => oldCapability.assertInstall("turn_old", oldPlan.sourceRefs)).toThrow(
      "gamebuddy_authored_context_stale_superseded",
    );
    expect(() => newCapability.assertInstall("turn_new", newPlan.sourceRefs)).not.toThrow();
    await oldCapability.clear();
    expect(() => newCapability.prepare("preflight_still_current")).not.toThrow();
    await newCapability.clear();
  });

  it("rejects a different thread or profile sharing the same Pi session", async () => {
    const capability = publishGameBuddyAuthoredStableCatalog(scope, catalog());
    const foreignScope = { ...scope, threadId: "foreign-thread" };
    const foreignBody = { version: "gamebuddy-authored-context-catalog/v2" as const, scope: foreignScope, stableSources: [source] };
    const foreignCatalog = { ...foreignBody, canonicalHash: createHash("sha256").update(canonical(foreignBody)).digest("hex") };
    expect(() => publishGameBuddyAuthoredStableCatalog(foreignScope, foreignCatalog)).toThrow("scope_conflict");
    expect(() => capability.prepare("still_current")).not.toThrow();
    await capability.clear();
  });

  it("binds volatile refs to one durable turn, is idempotent, and rejects cross-turn use", async () => {
    const volatileContent = "The moon festival is tonight.";
    const volatileSource = { sourceId: "entry", kind: "lorebook_entry" as const, revision: "1", content: volatileContent, canonicalHash: createHash("sha256").update(volatileContent).digest("hex"), budgetTokens: 7, totalOrderKey: "0002", provenance: "fixture", selectionKeys: ["moon festival"] };
    const body = { version: "gamebuddy-authored-context-catalog/v2" as const, scope, stableSources: [source], volatileSources: [volatileSource] };
    const volatileCatalog = { ...body, canonicalHash: createHash("sha256").update(canonical(body)).digest("hex") };
    const capability = publishGameBuddyAuthoredStableCatalog(scope, volatileCatalog);
    const first = capability.materializeVolatileForTurn("turn_1", "Moon Festival", "tail");
    const second = capability.materializeVolatileForTurn("turn_1", "Moon Festival", "tail");
    expect(second).toEqual(first);
    expect(__gamebuddyReadAuthoredVolatileMaterialization(scope.sessionId)?.durableTurnId).toBe("turn_1");
    expect(() => capability.materializeVolatileForTurn("turn_2", "Moon Festival", "tail")).toThrow("cross_turn");
    capability.clearVolatileForTurn("turn_1");
    expect(__gamebuddyReadAuthoredVolatileMaterialization(scope.sessionId)).toBeUndefined();
    await capability.clear();
  });

  it("returns reference-only plans and rejects mismatched refs", async () => {
    const capability = publishGameBuddyAuthoredStableCatalog(scope, catalog());
    const plan = capability.prepare("preflight_01");
    expect(plan.sourceRefs[0]).not.toHaveProperty("content");
    expect(plan.sourceRefs[0].revision).toBe("1");
    expect(() => capability.assertInstall("turn_01", [{ ...plan.sourceRefs[0], revision: "2" }])).toThrow("gamebuddy_authored_context_plan_mismatch");
    await capability.clear();
    expect(() => capability.prepare("preflight_02")).toThrow("gamebuddy_authored_context_cleared");
    await capability.clear();
  });
});
