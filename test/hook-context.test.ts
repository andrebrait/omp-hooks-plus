import { beforeEach, describe, expect, test } from "bun:test";
import { claimInjectedContext, resetInjectedContext } from "../src/hook-context";

describe("hidden context dedup", () => {
  beforeEach(() => {
    resetInjectedContext();
  });

  test("identical content is claimed once per turn", () => {
    expect(claimInjectedContext("REMINDER")).toBe(true);
    expect(claimInjectedContext("REMINDER")).toBe(false);
    expect(claimInjectedContext("REMINDER")).toBe(false);
  });

  test("distinct content is always claimed", () => {
    expect(claimInjectedContext("FIRST")).toBe(true);
    expect(claimInjectedContext("SECOND")).toBe(true);
  });

  test("a new turn re-arms the same content", () => {
    expect(claimInjectedContext("REMINDER")).toBe(true);
    resetInjectedContext();
    expect(claimInjectedContext("REMINDER")).toBe(true);
  });

  test("whitespace differences are distinct claims, matching Claude's exact-command dedup", () => {
    expect(claimInjectedContext("REMINDER")).toBe(true);
    expect(claimInjectedContext(" REMINDER")).toBe(true);
  });
});
