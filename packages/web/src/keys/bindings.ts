import { keyEngine, type Binding, type KeyContext } from "@platform/keys";
import { sendComposeReady } from "../lib/composeAttach";
import { mailStore } from "../store/mailStore";
import { inboxGrouping, inboxLenses, isInboxList, lensView, shownTopic, TOPIC_ROW } from "../store/selectors";
import { orderedAccounts } from "../store/selectors";
import type { ViewId } from "../store/types";

// Derive the active key context from store state. Priority mirrors visual
// stacking: overlays first, then compose focus, then thread, then list.
export function activeContext(): KeyContext {
  const s = mailStore.getState();
  if (Object.keys(s.accounts).length === 0) return "welcome";
  if (s.calendarDialogOpen) return "settings";
  if (s.paletteOpen) return "palette";
  if (s.helpOpen) return "help";
  if (s.memoriesOpen) return "memories";
  if (s.settingsOpen) return "settings";
  if (s.filtersOpen) return "settings";
  if (s.clusterPickerOpen) return "settings";
  if (s.labelPickerOpen) return "labelPicker";
  if (s.categoryPickerOpen) return "categoryPicker";
  if (s.timePicker) return "timePicker";
  if (s.composeDraftId && !s.composeMinimized) return "compose";
  if (s.searchOpen) return "search";
  if (s.openThreadId) return "thread";
  if (s.activeView === "sweep") return "sweep";
  if (s.activeView === "calendar") return "settings";
  return "list";
}

const S = () => mailStore.getState();

const go = (view: ViewId) => () => S().setView(view);

/** g 1..9 — switch to the Nth account in stable attach order. */
function switchAccount(index: number): void {
  const s = S();
  const target = orderedAccounts(s.accounts)[index];
  if (target) s.setAccountScope(target._id);
}

// Reading surfaces — where mail gestures apply.
const READING: KeyContext[] = ["list", "thread"];

export function calendarCommand(command: string): void {
  window.dispatchEvent(new CustomEvent("whisk:calendar-command", { detail: command }));
}

const calendarKeys = () => {
  const s = S();
  return s.activeView === "calendar" && !s.calendarDialogOpen && !s.paletteOpen && !s.helpOpen && !s.settingsOpen && !s.filtersOpen && !s.clusterPickerOpen && !s.memoriesOpen && !s.labelPickerOpen && !s.categoryPickerOpen && !s.timePicker && !s.searchOpen && !s.openThreadId && !(s.composeDraftId && !s.composeMinimized) && document.activeElement?.tagName !== "SELECT";
};

export const BINDINGS: Binding[] = [
  { keys: "g e", context: READING, group: "Go to", description: "Calendar", handler: go("calendar") },
  { keys: "g i", context: "settings", when: calendarKeys, group: "Calendar", description: "Inbox", handler: go("inbox") },
  { keys: "g ,", context: "settings", when: calendarKeys, group: "Calendar", description: "Settings", handler: () => S().setSettings(true) },
  { keys: "?", context: "settings", when: calendarKeys, group: "Calendar", description: "Keyboard help", handler: () => S().setHelp(true) },
  ...([["n", "new", "New event"], ["t", "today", "Today"], ["j", "down", "Next event"], ["k", "up", "Previous event"], ["[", "previous", "Previous day"], ["]", "next", "Next day"]] as const).map(([keys, command, description]): Binding => ({ keys, context: "settings", when: calendarKeys, group: "Calendar", description, handler: () => calendarCommand(command) })),
  { keys: "T", context: READING, group: "Topics", description: "Move to topic…", handler: () => S().setClusterPicker(true) },
  { keys: "v", context: "list", group: "Topics", description: "Inbox as a list, or as topics", when: () => isInboxList(S().activeView), handler: () => { const s = S(); s.setInboxGrouped(!inboxGrouping(s).grouped); } },
  { keys: "h", context: "list", group: "Topics", description: "Hide or unhide the topic under the cursor", when: () => isInboxList(S().activeView) || S().activeView.startsWith("cluster:"), handler: () => S().hideFocusedTopic() },
  { keys: "g o", context: READING, group: "Topics", description: "Open this conversation’s topic", handler: () => { const s = S(); const id = s.openThreadId ?? s.focusedThreadId; const cid = id?.startsWith(TOPIC_ROW) ? id.slice(TOPIC_ROW.length) : id ? s.threads[id]?.cluster_id : undefined; const c = shownTopic(cid ? s.clusters[cid] : undefined, s.clusters); if (c) { if (s.openThreadId) s.closeThread(); s.setView(`cluster:${c._id}`); } else s.pushToast("This conversation has no topic yet"); } },
  // ——— Navigate ———
  { keys: "j", context: READING, group: "Navigate", description: "Next conversation", handler: () => S().moveFocus(1) },
  { keys: "k", context: READING, group: "Navigate", description: "Previous conversation", handler: () => S().moveFocus(-1) },
  { keys: "arrowdown", context: READING, group: "Navigate", description: "Next conversation", hidden: true, handler: () => S().moveFocus(1) },
  { keys: "arrowup", context: READING, group: "Navigate", description: "Previous conversation", hidden: true, handler: () => S().moveFocus(-1) },
  { keys: "g g", context: READING, group: "Navigate", description: "First conversation", handler: () => S().focusEdge("first") },
  { keys: "G", context: READING, group: "Navigate", description: "Last conversation", handler: () => S().focusEdge("last") },
  { keys: "ctrl+d", context: READING, group: "Navigate", description: "Down half a page", handler: () => S().moveFocus(10) },
  { keys: "ctrl+u", context: READING, group: "Navigate", description: "Up half a page", handler: () => S().moveFocus(-10) },
  { keys: "enter", context: "list", group: "Navigate", description: "Open conversation", handler: () => S().openFocused() },
  { keys: "o", context: "list", group: "Navigate", description: "Open conversation", hidden: true, handler: () => S().openFocused() },
  { keys: "escape", context: "thread", group: "Navigate", description: "Back to list", handler: () => S().closeThread() },
  { keys: "h", context: "thread", group: "Navigate", description: "Back to list", hidden: true, handler: () => S().closeThread() },
  { keys: "n", context: "thread", group: "Navigate", description: "Next message", handler: () => S().moveMsgFocus(1) },
  { keys: "p", context: "thread", group: "Navigate", description: "Previous message", handler: () => S().moveMsgFocus(-1) },
  { keys: "o", context: "thread", group: "Navigate", description: "Open / close message", handler: () => S().toggleMsgExpanded() },
  { keys: "enter", context: "thread", group: "Navigate", description: "Open / close message", hidden: true, handler: () => S().toggleMsgExpanded() },
  { keys: ";", context: "thread", group: "Navigate", description: "Open every message", handler: () => S().setAllMsgExpanded(true) },
  { keys: "A", context: "thread", group: "Navigate", description: "View the files in this conversation", handler: () => S().openAttachment() },
  { keys: ":", context: "thread", group: "Navigate", description: "Close every message", handler: () => S().setAllMsgExpanded(false) },

  // ——— Views ———
  { keys: "g i", context: READING, group: "Go to", description: "Inbox", handler: go("inbox") },
  { keys: "g s", context: READING, group: "Go to", description: "Starred", handler: go("starred") },
  { keys: "g d", context: READING, group: "Go to", description: "Drafts", handler: go("drafts") },
  { keys: "g t", context: READING, group: "Go to", description: "Sent", handler: go("sent") },
  { keys: "g a", context: READING, group: "Go to", description: "Archive", handler: go("archive") },
  { keys: "g #", context: READING, group: "Go to", description: "Trash", handler: go("trash") },
  { keys: "g !", context: READING, group: "Go to", description: "Spam", handler: go("spam") },
  { keys: "g c", context: READING, group: "Go to", description: "Sweep by lane", handler: go("sweep") },
  { keys: "g z", context: READING, group: "Go to", description: "Later (snoozed)", handler: go("later") },
  { keys: "g w", context: READING, group: "Go to", description: "Waiting for reply", handler: go("waiting") },
  { keys: "g ,", context: READING, group: "Go to", description: "Settings", handler: () => S().setSettings(true) },
  { keys: "mod+,", context: "global", group: "Go to", description: "Settings", allowInInput: true, handler: () => {
    const s = S();
    s.setSettings(!s.settingsOpen);
  } },
  { keys: "g f", context: READING, group: "Go to", description: "Filters", handler: () => S().setFilters(true) },

  // ——— Accounts ———
  { keys: "g 0", context: READING, group: "Accounts", description: "All inboxes", handler: () => S().setAccountScope("all") },
  { keys: "g 1", context: READING, group: "Accounts", description: "Account 1…9", handler: () => switchAccount(0) },
  ...[2, 3, 4, 5, 6, 7, 8, 9].map((n): Binding => ({
    keys: `g ${n}`,
    context: READING,
    group: "Accounts",
    description: `Account ${n}`,
    hidden: true,
    handler: () => switchAccount(n - 1),
  })),

  // ——— Act on mail ———
  { keys: "e", context: READING, group: "Actions", description: "Archive", handler: () => S().archive() },
  { keys: "#", context: READING, group: "Actions", description: "Move to trash", handler: () => S().trash() },
  { keys: "!", context: READING, group: "Actions", description: "Mark as spam", handler: () => S().markSpam() },
  { keys: "s", context: READING, group: "Actions", description: "Star / unstar", handler: () => S().toggleStar() },
  { keys: "I", context: READING, group: "Actions", description: "Mark as read", handler: () => S().setRead(true) },
  { keys: "U", context: READING, group: "Actions", description: "Mark as unread", handler: () => S().setRead(false) },
  { keys: "l", context: READING, group: "Actions", description: "Label…", handler: () => S().setLabelPicker(true) },
  { keys: "m", context: READING, group: "Actions", description: "File under…", handler: () => S().setCategoryPicker(true) },
  { keys: "+", context: READING, group: "Actions", description: "Belongs in this list (Important from Other)", handler: () => S().markInLens(true) },
  { keys: "-", context: READING, group: "Actions", description: "Does not belong in this list", handler: () => S().markInLens(false) },
  { keys: "i", context: "list", group: "Go to", description: "Next inbox list: Important, your views, Other", when: () => isInboxList(S().activeView), handler: () => { const s = S(); const views = [...inboxLenses(s).map((l) => lensView(l.id)), "other" as const]; s.setView(views[(views.indexOf(s.activeView as never) + 1) % views.length]); } },
  { keys: "z", context: READING, group: "Actions", description: "Snooze…", handler: () => S().setTimePicker("snooze") },
  { keys: "F", context: READING, group: "Actions", description: "Watch for a reply…", handler: () => S().setTimePicker("followup") },
  { keys: "backspace", context: READING, group: "Actions", description: "Clear reminder", handler: () => S().unRemind() },
  { keys: "u", context: READING, group: "Actions", description: "Undo last action", handler: () => S().undo() },

  // ——— Whisk AI ———
  { keys: "t", context: "thread", group: "Whisk", description: "Summarize conversation", handler: () => S().summarizeThread() },
  { keys: "R", context: "thread", group: "Whisk", description: "Draft the reply for me", handler: () => S().aiDraftReply() },

  // ——— Sweep ———
  { keys: "j", context: "sweep", group: "Sweep", description: "Next card", handler: () => S().moveSweep(1) },
  { keys: "k", context: "sweep", group: "Sweep", description: "Previous card", handler: () => S().moveSweep(-1) },
  { keys: "arrowdown", context: "sweep", group: "Sweep", description: "Next card", hidden: true, handler: () => S().moveSweep(1) },
  { keys: "arrowup", context: "sweep", group: "Sweep", description: "Previous card", hidden: true, handler: () => S().moveSweep(-1) },
  { keys: "enter", context: "sweep", group: "Sweep", description: "Open lane", handler: () => S().sweepAct("open") },
  { keys: "o", context: "sweep", group: "Sweep", description: "Open lane", hidden: true, handler: () => S().sweepAct("open") },
  { keys: "e", context: "sweep", group: "Sweep", description: "Archive every conversation in it", handler: () => S().sweepAct("archive") },
  { keys: "#", context: "sweep", group: "Sweep", description: "Trash every conversation in it", handler: () => S().sweepAct("trash") },
  { keys: "u", context: "sweep", group: "Sweep", description: "Undo last action", handler: () => S().undo() },
  { keys: "escape", context: "sweep", group: "Sweep", description: "Back to inbox", handler: go("inbox") },
  { keys: "?", context: "sweep", group: "Search", description: "Keyboard help", hidden: true, handler: () => S().setHelp(true) },
  { keys: "mod+k", context: "sweep", group: "Search", description: "Command palette", hidden: true, allowInInput: true, handler: () => S().setPalette(true) },

  // ——— Overlay escapes ———
  { keys: "escape", context: "categoryPicker", group: "Search", description: "Close", allowInInput: true, hidden: true, handler: () => S().setCategoryPicker(false) },
  { keys: "escape", context: "timePicker", group: "Search", description: "Close", allowInInput: true, hidden: true, handler: () => S().setTimePicker(null) },
  { keys: "escape", context: "memories", group: "Search", description: "Close", allowInInput: true, hidden: true, handler: () => S().setMemories(false) },
  { keys: "escape", context: "settings", when: () => !S().calendarDialogOpen && (S().activeView !== "calendar" || S().settingsOpen || S().filtersOpen || S().clusterPickerOpen), group: "Search", description: "Close", allowInInput: true, hidden: true, handler: () => { const s = S(); if (s.filtersOpen) s.setFilters(false); else if (s.clusterPickerOpen) s.setClusterPicker(false); else s.setSettings(false); } },
  { keys: "x", context: "list", group: "Select", description: "Select conversation", handler: () => { S().toggleSelect(); S().moveFocus(1); } },
  // Escape steps out of whatever is nearest: a selection, an open topic,
  // a topic's own page, a search.
  { keys: "escape", context: "list", group: "Select", description: "Clear selection · back", handler: () => { const s = S(); if (Object.keys(s.selected).length) s.clearSelection(); else if (s.activeView.startsWith("cluster:")) s.setView("inbox"); else if (s.activeView.startsWith("search:")) s.setView(s.lastNonSearchView); } },

  // ——— Compose ———
  { keys: "c", context: READING, group: "Compose", description: "New message", handler: () => {
    const s = S();
    // Don't orphan an in-progress draft: if one is minimized, restore it.
    if (s.composeDraftId && s.composeMinimized) s.minimizeCompose(false);
    else if (!s.composeDraftId) s.startCompose("new");
  } },
  { keys: "r", context: "thread", group: "Compose", description: "Reply", handler: () => { const s = S(); const t = s.openThreadId ? s.threads[s.openThreadId] : null; if (t) s.startCompose("reply", t.gmail_id); } },
  { keys: "a", context: "thread", group: "Compose", description: "Reply all", handler: () => { const s = S(); const t = s.openThreadId ? s.threads[s.openThreadId] : null; if (t) s.startCompose("replyAll", t.gmail_id); } },
  { keys: "f", context: "thread", group: "Compose", description: "Forward", handler: () => { const s = S(); const t = s.openThreadId ? s.threads[s.openThreadId] : null; if (t) s.startCompose("forward", t.gmail_id); } },
  { keys: "mod+enter", context: "compose", group: "Compose", description: "Send", allowInInput: true, handler: () => void sendComposeReady() },
  { keys: "mod+e", context: "compose", group: "Compose", description: "Edit recipients and subject", allowInInput: true, handler: () => { const s = S(); s.setComposeHeadOpen(!s.composeHeadOpen); } },
  { keys: "escape", context: "compose", group: "Compose", description: "Minimize compose", allowInInput: true, handler: () => S().minimizeCompose(true) },
  { keys: "mod+backspace", context: "compose", group: "Compose", description: "Discard draft", allowInInput: true, handler: () => S().discardCompose() },

  // ——— Search & overlays ———
  { keys: "/", context: READING, group: "Search", description: "Search", handler: () => S().setSearch(true) },
  { keys: "enter", context: "search", group: "Search", description: "Run search", allowInInput: true, hidden: true, handler: () => S().commitSearch() },
  { keys: "escape", context: "search", group: "Search", description: "Close search", allowInInput: true, hidden: true, handler: () => S().setSearch(false) },
  { keys: "mod+k", context: "global", when: () => !S().calendarDialogOpen, group: "Search", description: "Command palette", allowInInput: true, handler: () => { const s = S(); s.setPalette(!s.paletteOpen); } },
  { keys: "?", context: READING, group: "Search", description: "Keyboard help", handler: () => S().setHelp(true) },
  { keys: "escape", context: "help", group: "Search", description: "Close help", hidden: true, handler: () => S().setHelp(false) },
  { keys: "escape", context: "palette", group: "Search", description: "Close palette", allowInInput: true, hidden: true, handler: () => S().setPalette(false) },
  { keys: "escape", context: "labelPicker", group: "Search", description: "Close label picker", allowInInput: true, hidden: true, handler: () => S().setLabelPicker(false) },
];

/** Runs the binding a keycap shows, as if its keys were pressed, so a hint
 *  clicked with the mouse does exactly what the key does. */
export function runKey(spec: string): void {
  const b = keyEngine.activeFor(activeContext()).find((b) => b.keys === spec && (!b.when || b.when()));
  b?.handler();
}

let registered = false;
export function registerBindings(): void {
  if (registered) return;
  registered = true;
  keyEngine.register(BINDINGS);
  keyEngine.setContextSource(activeContext);
  keyEngine.setPendingListener((pending) => mailStore.getState().setPendingKeys(pending));
}
