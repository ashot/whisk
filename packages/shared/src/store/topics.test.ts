import { expect, test } from "bun:test";
import { topicClusters, topicTree, topLevel, shownTopic, threadInView, inboxItems, inboxUnreadCount, topicRowId, LOOSE_SECTION } from "./selectors";
import { mailStore } from "./mailStore";
import type { Cluster, Thread } from "./types";
const topic: Cluster = { _id: "topic-one", account_id: "a", name: "Admissions", description: "School applications", hue: 20, source: "user", created_at: 1, updated_at: 1 };
const thread: Thread = { _id: "row-one", account_id: "a", gmail_id: "one", subject: "Tour", snippet: "", participants: [], message_count: 1, last_at: 1, label_ids: ["INBOX"], is_unread: true, is_starred: false, has_attachments: false, updated_at: 1, cluster_id: topic._id };
test("topic piles count only live inbox mail in the selected account", () => {
  const archived = { ...thread, _id: "two", label_ids: [] };
  const other = { ...thread, _id: "three", account_id: "b", cluster_id: "other-topic" };
  const piles = topicClusters({ one: thread, two: archived, three: other }, { [topic._id]: topic }, "a");
  expect(piles[0].threads).toEqual([thread]);
  expect(piles[0].unread).toBe(1);
  expect(threadInView(archived, `cluster:${topic._id}`)).toBe(false);
});

const mk = (id: string, last_at: number, extra: Partial<Thread> = {}): Thread => ({ ...thread, _id: id, gmail_id: id, last_at, cluster_id: undefined, ...extra });
const other: Cluster = { ...topic, _id: "topic-two", name: "Temu Deals", source: "ai" };
const theme: Cluster = { ...topic, _id: "theme-one", name: "Shopping", kind: "theme", source: "ai" };
const inTheme: Cluster = { ...other, _id: "topic-three", name: "Ring Promos", parent_id: theme._id };

test("the inbox as topics: one section per topic where its newest conversation would be, a peek, N more, muted topics in a footer", () => {
  const threads = {
    a: mk("a", 50),
    b: mk("b", 40, { cluster_id: topic._id }),
    c: mk("c", 30, { cluster_id: topic._id }),
    d: mk("d", 20),
    e: mk("e", 10, { cluster_id: other._id }),
  };
  const items = inboxItems(threads, { [topic._id]: topic, [other._id]: other }, "a");
  // Topics first, newest first; the mail no topic claimed is one last
  // section shown in full.
  expect(items.map(i => [i.kind, i.id])).toEqual([
    ["section", topicRowId(topic._id)], ["thread", "b"], ["thread", "c"],
    ["section", topicRowId(other._id)], ["thread", "e"],
    ["section", topicRowId(LOOSE_SECTION)], ["thread", "a"], ["thread", "d"],
  ]);
  expect(items.find(i => i.id === "b")).toMatchObject({ hue: topic.hue });
  expect(items.find(i => i.id === "a")).toMatchObject({ hue: undefined });
  // Past the peek, the section says how many more; one over shows them all.
  const big = Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`t${n}`, mk(`t${n}`, 100 - n, { cluster_id: topic._id })]));
  const peek = inboxItems(big, { [topic._id]: topic }, "a");
  expect(peek.map(i => i.kind)).toEqual(["section", "thread", "thread", "thread", "more"]);
  expect(peek[4]).toMatchObject({ kind: "more", rest: 3 });
  const four = inboxItems(Object.fromEntries(Object.entries(big).slice(0, 4)), { [topic._id]: topic }, "a");
  expect(four.map(i => i.kind)).toEqual(["section", "thread", "thread", "thread", "thread"]);
  // Muted topics leave the list and the unread count, and wait in the footer.
  const muted = { [topic._id]: topic, [other._id]: { ...other, hidden: true } };
  const withMuted = inboxItems(threads, muted, "a");
  expect(withMuted.map(i => i.id)).toEqual([topicRowId(topic._id), "b", "c", topicRowId(LOOSE_SECTION), "a", "d", "muted"]);
  expect(withMuted.find(i => i.kind === "muted")).toMatchObject({ piles: [expect.objectContaining({ meta: expect.objectContaining({ id: other._id }) })] });
  expect(inboxUnreadCount(threads, "a", muted)).toBe(4);
  expect(inboxUnreadCount(threads, "a")).toBe(5);
  // A topic of the person's with no inbox mail has no section.
  const empty = inboxItems({ a: threads.a }, { [topic._id]: topic }, "a");
  expect(empty.map(i => i.id)).toEqual([topicRowId(LOOSE_SECTION), "a"]);
});

test("a theme is one section holding its streams' mail and its own; a stream's conversation shows the theme; a page lists all of it", () => {
  const threads = {
    a: mk("a", 60),
    b: mk("b", 50, { cluster_id: inTheme._id }),
    c: mk("c", 40, { cluster_id: theme._id }),
    d: mk("d", 30, { cluster_id: inTheme._id }),
    e: mk("e", 20, { cluster_id: other._id }),
  };
  const clusters = { [theme._id]: theme, [inTheme._id]: inTheme, [other._id]: other };
  const tree = topicTree(threads, clusters, "a");
  expect(tree.themes.map(n => [n.pile.meta.id, n.pile.threads.length, n.streams.map(s => s.meta.id), n.direct.map(t => t._id)])).toEqual([[theme._id, 3, [inTheme._id], ["c"]]]);
  expect(tree.loose.map(p => p.meta.id)).toEqual([other._id]);
  expect(topLevel(threads, clusters, "a").map(p => p.meta.id)).toEqual([theme._id, other._id]);
  expect(shownTopic(inTheme, clusters)?._id).toBe(theme._id);
  expect(shownTopic(other, clusters)?._id).toBe(other._id);
  const items = inboxItems(threads, clusters, "a");
  expect(items.map(i => i.id)).toEqual([topicRowId(theme._id), "b", "c", "d", topicRowId(other._id), "e", topicRowId(LOOSE_SECTION), "a"]);
  // The theme's page is everything in it, newest first, flat.
  expect(inboxItems(threads, clusters, "a", theme._id).map(i => i.id)).toEqual(["b", "c", "d"]);
  expect(inboxItems(threads, clusters, "a", LOOSE_SECTION).map(i => i.id)).toEqual(["a"]);
  // A muted theme mutes its streams too.
  expect(inboxUnreadCount(threads, "a", { ...clusters, [theme._id]: { ...theme, hidden: true } })).toBe(2);
});

test("a section head is a gesture target: e archives the whole topic and the cursor stays on a surviving row", () => {
  const threads = { a: mk("a", 50), b: mk("b", 40, { cluster_id: topic._id }), c: mk("c", 30, { cluster_id: topic._id }), d: mk("d", 20) };
  mailStore.setState({ threads, clusters: { [topic._id]: topic }, accountScope: "a", activeView: "inbox", clientState: { inbox: { grouped: true } }, focusedThreadId: topicRowId(topic._id), selected: {}, openThreadId: null, undoStack: [] });
  const st = mailStore.getState();
  // The cursor walks heads and conversations; "N more" is not a stop.
  st.moveFocus(1);
  expect(mailStore.getState().focusedThreadId).toBe("b");
  st.moveFocus(-1);
  expect(mailStore.getState().focusedThreadId).toBe(topicRowId(topic._id));
  st.toggleSelect();
  expect(Object.keys(mailStore.getState().selected).sort()).toEqual(["b", "c"]);
  st.clearSelection();
  st.archive();
  const after = mailStore.getState();
  expect(after.threads.b.label_ids).not.toContain("INBOX");
  expect(after.threads.c.label_ids).not.toContain("INBOX");
  expect(after.threads.a.label_ids).toContain("INBOX");
  expect(after.focusedThreadId).toBe(topicRowId(LOOSE_SECTION));
  mailStore.setState({ threads: {}, clusters: {}, focusedThreadId: null, activeView: "inbox", accountScope: "all", clientState: {}, selected: {} });
});

test("enter on a section head opens the topic's page, and escape there is the inbox", () => {
  const threads = { a: mk("a", 60), b: mk("b", 50, { cluster_id: inTheme._id }), c: mk("c", 40, { cluster_id: theme._id }) };
  const clusters = { [theme._id]: theme, [inTheme._id]: inTheme };
  mailStore.setState({ threads, clusters, accountScope: "a", activeView: "inbox", clientState: { inbox: { grouped: true } }, focusedThreadId: topicRowId(theme._id), selected: {}, openThreadId: null });
  const st = mailStore.getState();
  st.openFocused();
  let s = mailStore.getState();
  expect(s.openThreadId).toBeNull();
  expect(s.activeView).toBe(`cluster:${theme._id}`);
  expect(s.focusedThreadId).toBe("b");
  st.moveFocus(1);
  expect(mailStore.getState().focusedThreadId).toBe("c");
  st.setView("inbox");
  expect(mailStore.getState().activeView).toBe("inbox");
  mailStore.setState({ threads: {}, clusters: {}, focusedThreadId: null, activeView: "inbox", accountScope: "all", clientState: {} });
});

test("hiding the topic under the cursor takes it out of the list and leaves its mail in the inbox", () => {
  const threads = { a: mk("a", 50), b: mk("b", 40, { cluster_id: inTheme._id }) };
  const clusters = { [theme._id]: theme, [inTheme._id]: inTheme };
  mailStore.setState({ threads, clusters, accountScope: "a", activeView: "inbox", clientState: { inbox: { grouped: true } }, focusedThreadId: topicRowId(theme._id), selected: {}, openThreadId: null, undoStack: [] });
  mailStore.getState().hideFocusedTopic();
  let s = mailStore.getState();
  expect(s.clusters[theme._id].hidden).toBe(true);
  expect(s.clusters[theme._id].archive_new_since).toBeUndefined();
  expect(s.threads.b.label_ids).toContain("INBOX");
  expect(s.focusedThreadId).toBe(topicRowId(LOOSE_SECTION));
  // The hidden theme waits in the footer, so it can be unhidden.
  expect(inboxItems(s.threads, s.clusters, "a").map(i => i.id)).toEqual([topicRowId(LOOSE_SECTION), "a", "muted"]);
  // h on a conversation in a stream acts on the theme the stream sits in.
  mailStore.setState({ focusedThreadId: "b" });
  mailStore.getState().hideFocusedTopic();
  s = mailStore.getState();
  expect(s.clusters[theme._id].hidden).toBe(false);
  expect(s.clusters[theme._id].archive_new_since).toBeUndefined();
  expect(inboxItems(s.threads, s.clusters, "a").map(i => i.id)).toEqual([topicRowId(theme._id), "b", topicRowId(LOOSE_SECTION), "a"]);
  mailStore.setState({ threads: {}, clusters: {}, focusedThreadId: null, clientState: {} });
});

test("hiding a topic by id does not move the cursor off another section", () => {
  const threads = { a: mk("a", 50), b: mk("b", 40, { cluster_id: topic._id }), e: mk("e", 10, { cluster_id: other._id }) };
  const clusters = { [topic._id]: topic, [other._id]: other };
  mailStore.setState({ threads, clusters, accountScope: "a", activeView: "inbox", clientState: { inbox: { grouped: true } }, focusedThreadId: topicRowId(topic._id), selected: {}, openThreadId: null, undoStack: [] });
  mailStore.getState().hideTopic(other._id);
  const s = mailStore.getState();
  expect(s.clusters[other._id].hidden).toBe(true);
  expect(s.threads.e.label_ids).toContain("INBOX");
  expect(s.focusedThreadId).toBe(topicRowId(topic._id));
  expect(inboxItems(s.threads, s.clusters, "a").map(i => i.id)).toEqual([topicRowId(topic._id), "b", topicRowId(LOOSE_SECTION), "a", "muted"]);
  mailStore.setState({ threads: {}, clusters: {}, focusedThreadId: null, clientState: {} });
});
