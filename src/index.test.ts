import { describe, expect, it } from "vitest";
import { main, NotImplemented } from "./index.ts";

// Guards the scaffold itself: the moment `main` returns instead of throwing, the
// tool is claiming a verdict it did not compute (SPEC INV-1). This test should
// fail loudly when T8 lands and be replaced then, not deleted quietly.
describe("main", () => {
  it("throws rather than reporting a result it has not computed", () => {
    expect(() => main([])).toThrow(NotImplemented);
  });
});
