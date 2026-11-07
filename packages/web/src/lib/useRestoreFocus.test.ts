import { expect, test } from "bun:test";
import { restoreFocusAfterUnmount } from "./useRestoreFocus";

function fixture() {
  let focused = false;
  const body = {} as HTMLElement;
  const document = { body, activeElement: body };
  const target = {
    isConnected: true,
    ownerDocument: document,
    focus: () => { focused = true; },
  };
  return { target, document, focused: () => focused };
}

test("focus returns after the overlay finishes unmounting", async () => {
  const { target, focused } = fixture();
  restoreFocusAfterUnmount(target, { current: false });
  expect(focused()).toBe(false);
  await Promise.resolve();
  expect(focused()).toBe(true);
});

test("StrictMode effect reattachment does not steal overlay autofocus", async () => {
  const { target, focused } = fixture();
  const mounted = { current: false };
  restoreFocusAfterUnmount(target, mounted);
  mounted.current = true;
  await Promise.resolve();
  expect(focused()).toBe(false);
  mounted.current = false;
  restoreFocusAfterUnmount(target, mounted);
  await Promise.resolve();
  expect(focused()).toBe(true);
});

test("a return target detached during unmount is not focused", async () => {
  const { target, focused } = fixture();
  restoreFocusAfterUnmount(target, { current: false });
  target.isConnected = false;
  await Promise.resolve();
  expect(focused()).toBe(false);
});

test("a replacement overlay keeps its own autofocus", async () => {
  const { target, document, focused } = fixture();
  restoreFocusAfterUnmount(target, { current: false });
  document.activeElement = {} as HTMLElement;
  await Promise.resolve();
  expect(focused()).toBe(false);
});
