import { describe, expect, test } from "bun:test";
import { applyClick, applyRect, pickAt } from "../src/web/picking";

describe("Unity-style picking", () => {
  test("a click picks the nearest object", () => {
    expect(pickAt(["a", "b", "c"], null, false)).toBe("a");
    expect(pickAt([], "a", true)).toBeNull();
  });

  test("clicking the same spot again cycles to the object behind, and wraps", () => {
    expect(pickAt(["a", "b", "c"], "a", true)).toBe("b");
    expect(pickAt(["a", "b", "c"], "b", true)).toBe("c");
    expect(pickAt(["a", "b", "c"], "c", true)).toBe("a");
  });

  test("a click elsewhere, or with something else active, starts from the nearest again", () => {
    expect(pickAt(["a", "b"], "a", false)).toBe("a");
    expect(pickAt(["a", "b"], "z", true)).toBe("a");
  });

  test("plain click replaces; on empty space it clears", () => {
    expect(applyClick(["x", "y"], "a", false)).toEqual(["a"]);
    expect(applyClick(["x", "y"], null, false)).toEqual([]);
  });

  test("shift/cmd click toggles and leaves the selection alone on empty space", () => {
    expect(applyClick(["x"], "a", true)).toEqual(["x", "a"]);
    expect(applyClick(["x", "a"], "a", true)).toEqual(["x"]);
    expect(applyClick(["x"], null, true)).toEqual(["x"]);
  });

  test("rectangle: replace, shift adds, cmd removes", () => {
    expect(applyRect(["x"], ["a", "b"], "replace")).toEqual(["a", "b"]);
    expect(applyRect(["x", "a"], ["a", "b"], "add")).toEqual(["x", "a", "b"]);
    expect(applyRect(["x", "a", "b"], ["a"], "remove")).toEqual(["x", "b"]);
  });
});
