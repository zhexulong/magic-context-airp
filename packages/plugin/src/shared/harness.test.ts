import { describe, expect, test } from "bun:test";

import {
  _resetHarnessForTesting,
  getDeclaredProjectIdentity,
  setDeclaredProjectIdentity,
} from "./harness.ts";

describe("setDeclaredProjectIdentity", () => {
  test("clears to undefined on reset", () => {
    setDeclaredProjectIdentity("gamebuddy:git:abc");
    _resetHarnessForTesting();
    expect(getDeclaredProjectIdentity()).toBeUndefined();
  });

  test("returns the declared identity verbatim", () => {
    _resetHarnessForTesting();
    setDeclaredProjectIdentity("gamebuddy:dir:0123456789ab:continuity:c1");
    expect(getDeclaredProjectIdentity()).toBe("gamebuddy:dir:0123456789ab:continuity:c1");
    _resetHarnessForTesting();
  });

  test("rejecting whitespace keeps the identity unset and does not lock", () => {
    _resetHarnessForTesting();
    expect(() => setDeclaredProjectIdentity("has space")).toThrow();
    expect(getDeclaredProjectIdentity()).toBeUndefined();
    // A second valid call must still succeed (no partial lock).
    setDeclaredProjectIdentity("gamebuddy:valid");
    expect(getDeclaredProjectIdentity()).toBe("gamebuddy:valid");
    _resetHarnessForTesting();
  });

  test("a second, different declaration throws (identity is boot-time locked)", () => {
    _resetHarnessForTesting();
    setDeclaredProjectIdentity("gamebuddy:a");
    expect(() => setDeclaredProjectIdentity("gamebuddy:b")).toThrow(
      /already declared/,
    );
    expect(getDeclaredProjectIdentity()).toBe("gamebuddy:a");
    _resetHarnessForTesting();
  });

  test("re-declaring the same value is a harmless no-op", () => {
    _resetHarnessForTesting();
    setDeclaredProjectIdentity("gamebuddy:same");
    setDeclaredProjectIdentity("gamebuddy:same");
    expect(getDeclaredProjectIdentity()).toBe("gamebuddy:same");
    _resetHarnessForTesting();
  });
});