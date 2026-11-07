import { expect, test } from "bun:test";
import { ghostKeyAction } from "./composeGhost";

test("arrows and tab do nothing once the box has text", () => {
  const typed = { empty: false, count: 4, shift: false };
  expect(ghostKeyAction({ ...typed, key: "ArrowDown" })).toBeNull();
  expect(ghostKeyAction({ ...typed, key: "ArrowUp" })).toBeNull();
  expect(ghostKeyAction({ ...typed, key: "Tab" })).toBeNull();
});

test("while empty, tab accepts and arrows cycle", () => {
  const empty = { empty: true, count: 4, shift: false };
  expect(ghostKeyAction({ ...empty, key: "Tab" })).toBe("accept");
  expect(ghostKeyAction({ ...empty, key: "ArrowDown" })).toBe("next");
  expect(ghostKeyAction({ ...empty, key: "ArrowUp" })).toBe("prev");
  expect(ghostKeyAction({ ...empty, key: "Tab", shift: true })).toBe("prev");
});

test("a single suggestion does not steal the arrows", () => {
  expect(ghostKeyAction({ empty: true, count: 1, key: "ArrowDown", shift: false })).toBeNull();
  expect(ghostKeyAction({ empty: true, count: 1, key: "Tab", shift: false })).toBe("accept");
});
