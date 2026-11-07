import { afterEach, beforeEach, expect, test } from "bun:test";
import { KeyEngine } from "@platform/keys";
import { mailStore } from "../store/mailStore";
import { activeContext, BINDINGS } from "./bindings";
const previousDocument = globalThis.document;
let fired: string[];
let engine: KeyEngine;
beforeEach(() => {
  (globalThis as any).document = { activeElement: { tagName: "BUTTON" } };
  mailStore.setState({
    accounts: {
      a: { _id: "a", email: "a@example.com", provider: "demo", updated_at: 1 },
    } as any,
    activeView: "calendar",
    calendarDialogOpen: false,
    paletteOpen: false,
    helpOpen: false,
    settingsOpen: false,
    filtersOpen: false,
    clusterPickerOpen: false,
    memoriesOpen: false,
    labelPickerOpen: false,
    categoryPickerOpen: false,
    timePicker: null,
    searchOpen: false,
    openThreadId: null,
    composeDraftId: null,
  });
  fired = [];
  engine = new KeyEngine();
  engine.register(
    BINDINGS.map((binding) => ({
      ...binding,
      handler: () => fired.push(binding.description),
    })),
  );
  engine.setContextSource(activeContext);
});
afterEach(() => {
  (globalThis as any).document = previousDocument;
});
function press(key: string, tagName = "BUTTON", metaKey = false) {
  (document as any).activeElement = { tagName };
  return engine.handle({
    key,
    target: { tagName },
    metaKey,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as KeyboardEvent);
}
test("calendar keys never trigger mail actions", () => {
  for (const key of ["e", "a", "r", "c", "#", "x"])
    expect(press(key)).toBe(false);
  expect(press("n")).toBe(true);
  expect(fired).toEqual(["New event"]);
});
test("typing and calendar selects own their keys", () => {
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"])
    expect(press("n", tag)).toBe(false);
  expect(fired).toEqual([]);
});
test("native event dialogs own Escape and block background commands", () => {
  mailStore.setState({ calendarDialogOpen: true });
  for (const key of ["Escape", "n", "j", "t"]) expect(press(key)).toBe(false);
  expect(fired).toEqual([]);
});
test("calendar navigation and grouping settings remain separate", () => {
  expect(press("g")).toBe(true);
  expect(press("i")).toBe(true);
  expect(fired).toEqual(["Inbox"]);
  mailStore.setState({ filtersOpen: true });
  expect(press("n")).toBe(false);
  expect(press("Escape")).toBe(true);
  expect(fired).toEqual(["Inbox", "Close"]);
});

test("event dialogs outrank mail compose and other overlays", () => {
  mailStore.setState({
    calendarDialogOpen: true,
    composeDraftId: "draft",
    composeMinimized: false,
    paletteOpen: true,
  });
  expect(activeContext()).toBe("settings");
  expect(press("Escape")).toBe(false);
  expect(press("Enter", "INPUT", true)).toBe(false);
  expect(fired).toEqual([]);
});
