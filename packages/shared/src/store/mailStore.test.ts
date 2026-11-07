import { beforeEach, describe, expect, test } from "bun:test";
import { create } from "mutative";
import { applyClientPref, mailStore } from "./mailStore";
import { setRemoteSearch } from "./searchBridge";
import { threadDrafts } from "./selectors";
import { L, type Draft, type Thread } from "./types";
import { DEFAULT_IMPORTANCE_POLICY } from "../lib/importance";

// Integration: the mail store on the REAL platform engine. No dispatch/outbox
// wired (node test env) — these tests cover optimistic state, pending
// protection against server echoes, undo, and cursor behavior.

let seq = 0;
function serverThread(labels: string[], overrides: Partial<Thread> = {}): Thread {
  seq++;
  const id = `srv${String(seq).padStart(28, "0")}`.slice(0, 32);
  return {
    _id: id,
    account_id: "acct",
    gmail_id: `gm-${seq}`,
    subject: `Thread ${seq}`,
    snippet: "hello there",
    participants: [{ name: "Ada Lovelace", email: "ada@example.com" }],
    message_count: 1,
    last_at: 1000 + seq,
    label_ids: [...labels],
    is_unread: labels.includes(L.UNREAD),
    is_starred: labels.includes(L.STARRED),
    has_attachments: false,
    updated_at: 1000 + seq,
    ...overrides,
  };
}

function resetStore(): void {
  mailStore.setState({
    threads: {},
    threadMessages: {},
    labels: {},
    drafts: {},
    pending: {},
    selected: {},
    toasts: [],
    undoStack: [],
    focusedThreadId: null,
    openThreadId: null,
    activeView: "inbox",
    accountScope: "all",
    clientState: {},
    accounts: {
      acct: {
        _id: "acct",
        email: "me@example.com",
        provider: "demo",
        sync_status: "idle",
        updated_at: 0,
      },
    } as any,
  });
}

beforeEach(resetStore);

describe("archive", () => {
  test("removes INBOX locally, records undo, moves the cursor to the next row", () => {
    const a = serverThread([L.INBOX, L.UNREAD]);
    const b = serverThread([L.INBOX]);
    const c = serverThread([L.INBOX]);
    mailStore.getState().syncTable("threads", [a, b, c]);
    // Newest first: c, b, a. Focus the middle row (b).
    mailStore.getState().focusThread(b._id);

    mailStore.getState().archive();

    const s = mailStore.getState();
    expect(s.threads[b._id].label_ids).not.toContain(L.INBOX);
    // Cursor moved DOWN the list (next-older row, a).
    expect(s.focusedThreadId).toBe(a._id);
    expect(s.undoStack.length).toBe(1);
    expect(s.toasts.some((t) => t.kind === "undo")).toBe(true);
  });

  test("pending protection keeps the archive against a contradicting echo", () => {
    const a = serverThread([L.INBOX]);
    mailStore.getState().syncTable("threads", [a]);
    mailStore.getState().focusThread(a._id);
    mailStore.getState().archive();

    // Server re-sends the OLD labels (raced echo) — local wins.
    mailStore.getState().syncTable("threads", [{ ...a }]);
    expect(mailStore.getState().threads[a._id].label_ids).not.toContain(L.INBOX);

    // Server confirms the new labels — pending retires, values agree.
    const confirmed = {
      ...a,
      label_ids: a.label_ids.filter((l) => l !== L.INBOX),
      updated_at: a.updated_at + 10,
    };
    mailStore.getState().syncTable("threads", [confirmed]);
    const after = mailStore.getState();
    expect(after.threads[a._id].label_ids).not.toContain(L.INBOX);
    const pendingKeys = Object.keys(after.pending).filter((k) => k.startsWith("threads:"));
    expect(pendingKeys.length).toBe(0);
  });

  test("undo restores INBOX", () => {
    const a = serverThread([L.INBOX]);
    mailStore.getState().syncTable("threads", [a]);
    mailStore.getState().focusThread(a._id);
    mailStore.getState().archive();
    expect(mailStore.getState().threads[a._id].label_ids).not.toContain(L.INBOX);

    mailStore.getState().undo();
    expect(mailStore.getState().threads[a._id].label_ids).toContain(L.INBOX);
    expect(mailStore.getState().undoStack.length).toBe(0);
  });
});

describe("read state", () => {
  test("opening an unread thread clears UNREAD and derived flags", () => {
    const a = serverThread([L.INBOX, L.UNREAD]);
    mailStore.getState().syncTable("threads", [a]);
    mailStore.getState().openThread(a._id);
    const t = mailStore.getState().threads[a._id];
    expect(t.label_ids).not.toContain(L.UNREAD);
    expect(t.is_unread).toBe(false);
    expect(mailStore.getState().openThreadId).toBe(a._id);
  });
});

describe("selection", () => {
  test("bulk archive clears selection and targets every selected row", () => {
    const a = serverThread([L.INBOX]);
    const b = serverThread([L.INBOX]);
    const c = serverThread([L.INBOX]);
    mailStore.getState().syncTable("threads", [a, b, c]);
    mailStore.getState().focusThread(c._id);
    mailStore.getState().toggleSelect(c._id);
    mailStore.getState().toggleSelect(b._id);

    mailStore.getState().archive();
    const s = mailStore.getState();
    expect(s.threads[b._id].label_ids).not.toContain(L.INBOX);
    expect(s.threads[c._id].label_ids).not.toContain(L.INBOX);
    expect(s.threads[a._id].label_ids).toContain(L.INBOX);
    expect(Object.keys(s.selected).length).toBe(0);
  });
});

describe("compose & send", () => {
  test("sendCompose creates an optimistic sent thread and clears the draft", () => {
    mailStore.getState().startCompose("new");
    const draftId = mailStore.getState().composeDraftId!;
    expect(draftId).toBeTruthy();
    mailStore.getState().updateComposeDraft({
      to: [{ email: "grace@example.com" }],
      subject: "Hello",
      body_text: "A note.",
    });
    mailStore.getState().sendCompose();

    const s = mailStore.getState();
    expect(s.composeDraftId).toBeNull();
    expect(s.drafts[draftId]).toBeUndefined();
    const sent = Object.values(s.threads).find((t) => t.subject === "Hello");
    expect(sent).toBeTruthy();
    expect(sent!.label_ids).toContain(L.SENT);
    const msgs = s.threadMessages[sent!.gmail_id];
    expect(msgs?.length).toBe(1);
    expect(msgs![0].body_text).toBe("A note.");
  });

  test("sendCompose carries files onto the optimistic sent message", () => {
    mailStore.getState().startCompose("new");
    mailStore.getState().updateComposeDraft({
      to: [{ email: "grace@example.com" }],
      subject: "Deck",
      body_text: "Attached.",
      attachments: [{ filename: "q3.csv", mime_type: "text/csv", size: 12, storage_id: "st_1" }],
    });
    mailStore.getState().sendCompose();

    const s = mailStore.getState();
    const sent = Object.values(s.threads).find((t) => t.subject === "Deck")!;
    expect(sent.has_attachments).toBe(true);
    expect(s.threadMessages[sent.gmail_id]![0].attachments).toEqual([
      { filename: "q3.csv", mime_type: "text/csv", size: 12, gmail_attachment_id: "" },
    ]);
  });

  test("forwarding a thread seeds its files on the draft", () => {
    const a = serverThread([L.INBOX], { subject: "Lease", has_attachments: true });
    mailStore.getState().syncTable("threads", [a]);
    mailStore.getState().syncDetail("threadMessages", a.gmail_id, [
      {
        _id: "m1",
        account_id: "acct",
        thread_gmail_id: a.gmail_id,
        gmail_id: "m1",
        from: { email: "ada@example.com" },
        to: [{ email: "me@example.com" }],
        date: 1,
        snippet: "see attached",
        body_text: "see attached",
        label_ids: [],
        is_unread: false,
        attachments: [
          { filename: "lease.pdf", mime_type: "application/pdf", size: 1200, gmail_attachment_id: "att-1" },
        ],
        updated_at: 1,
      },
    ]);
    mailStore.getState().startCompose("forward", a.gmail_id);
    const d = mailStore.getState().drafts[mailStore.getState().composeDraftId!];
    expect(d.mode).toBe("forward");
    expect(d.attachments).toEqual([
      {
        filename: "lease.pdf",
        mime_type: "application/pdf",
        size: 1200,
        message_gmail_id: "m1",
        gmail_attachment_id: "att-1",
      },
    ]);
  });


  test("a forward is drafted and sent inside its conversation", () => {
    const a = serverThread([L.INBOX], { subject: "Lease" });
    mailStore.getState().syncTable("threads", [a]);
    mailStore.getState().syncDetail("threadMessages", a.gmail_id, [
      {
        _id: "m1",
        account_id: "acct",
        thread_gmail_id: a.gmail_id,
        gmail_id: "m1",
        from: { email: "ada@example.com" },
        to: [{ email: "me@example.com" }],
        date: 1,
        snippet: "hello",
        body_text: "hello",
        label_ids: [],
        is_unread: false,
        attachments: [],
        updated_at: 1,
      },
    ]);
    mailStore.getState().startCompose("forward", a.gmail_id);
    const fwdId = mailStore.getState().composeDraftId!;
    expect(threadDrafts(mailStore.getState().drafts, a.gmail_id).map((d) => d.client_id)).toEqual([fwdId]);

    // A reply is its own draft; forwarding again picks the forward back up.
    mailStore.getState().startCompose("reply", a.gmail_id);
    const replyId = mailStore.getState().composeDraftId!;
    expect(replyId).not.toBe(fwdId);
    mailStore.getState().startCompose("forward", a.gmail_id);
    expect(mailStore.getState().composeDraftId).toBe(fwdId);

    mailStore.getState().updateComposeDraft({ to: [{ email: "grace@example.com" }] });
    mailStore.getState().sendCompose();
    const msgs = mailStore.getState().threadMessages[a.gmail_id]!;
    expect(msgs.length).toBe(2);
    expect(msgs[1].to).toEqual([{ email: "grace@example.com" }]);
  });

  test("optimistic sent thread is superseded by the server row (no duplicate)", () => {
    mailStore.getState().startCompose("new");
    const draftId = mailStore.getState().composeDraftId!;
    mailStore.getState().updateComposeDraft({
      to: [{ email: "grace@example.com" }],
      subject: "Hello",
      body_text: "A note.",
    });
    mailStore.getState().sendCompose();

    // Stub thread present, keyed by the draft client id, carrying client_id.
    let s = mailStore.getState();
    const stub = s.threads[draftId];
    expect(stub).toBeTruthy();
    expect(stub.client_id).toBe(draftId);
    const gmailId = stub.gmail_id;

    // Server echoes the real thread row with a Convex _id and matching client_id.
    const serverId = "srv" + "0".repeat(29);
    mailStore.getState().syncTable("threads", [
      {
        _id: serverId,
        gmail_id: gmailId,
        client_id: draftId,
        subject: "Hello",
        snippet: "A note.",
        participants: [{ email: "me@example.com" }, { email: "grace@example.com" }],
        message_count: 1,
        last_at: Date.now(),
        label_ids: ["SENT"],
        is_unread: false,
        is_starred: false,
        has_attachments: false,
        updated_at: Date.now(),
      },
    ]);

    s = mailStore.getState();
    // Stub is gone, server row present — exactly one Sent thread, no duplicate.
    expect(s.threads[draftId]).toBeUndefined();
    expect(s.threads[serverId]).toBeTruthy();
    const sentThreads = Object.values(s.threads).filter((t) => t.gmail_id === gmailId);
    expect(sentThreads).toHaveLength(1);
    // No immortal thread lock left behind for either id. (The draft's own
    // `drafts:` exclude legitimately remains until the server tombstone arrives
    // — that's the delete, not a thread leak.)
    const stuckThreads = Object.keys(s.pending).filter((k) =>
      k.startsWith("threads:"),
    );
    expect(stuckThreads).toHaveLength(0);
  });

  test("reply does not write server-owned stamps, so the thread never freezes", () => {
    const a = serverThread([L.INBOX], { last_at: 1000, message_count: 1 });
    mailStore.getState().syncTable("threads", [a]);
    mailStore.getState().syncDetail("threadMessages", a.gmail_id, [
      {
        _id: "m1",
        thread_gmail_id: a.gmail_id,
        gmail_id: "m1",
        from: { email: "ada@example.com" },
        to: [{ email: "me@example.com" }],
        date: 1,
        snippet: "hi",
        body_text: "hi",
        label_ids: [],
        is_unread: false,
        attachments: [],
        updated_at: 1,
      },
    ]);
    mailStore.getState().startCompose("reply", a.gmail_id);
    mailStore.getState().updateComposeDraft({ body_text: "replying" });
    mailStore.getState().sendCompose();

    const s = mailStore.getState();
    // No pending lock on the server-owned stamps — only the SENT label (sorted).
    const locks = Object.keys(s.pending).filter((k) => k.startsWith(`threads:${a._id}:`));
    expect(locks).not.toContain(`threads:${a._id}:last_at`);
    expect(locks).not.toContain(`threads:${a._id}:updated_at`);
    expect(locks).not.toContain(`threads:${a._id}:message_count`);
    // Label list stays canonical (sorted) so its lock retires against the echo.
    const labels = s.threads[a._id].label_ids;
    expect(labels).toEqual([...labels].sort());
    expect(labels).toContain(L.SENT);
  });

  test("reply drafts prefill recipients from the last inbound message", () => {
    const a = serverThread([L.INBOX]);
    mailStore.getState().syncTable("threads", [a]);
    mailStore.getState().syncDetail("threadMessages", a.gmail_id, [
      {
        _id: "m1",
        thread_gmail_id: a.gmail_id,
        gmail_id: "m1",
        from: { name: "Ada Lovelace", email: "ada@example.com" },
        to: [{ email: "me@example.com" }],
        date: 1,
        snippet: "hi",
        body_text: "hi",
        label_ids: [],
        is_unread: false,
        attachments: [],
        updated_at: 1,
      },
    ]);
    mailStore.getState().startCompose("reply", a.gmail_id);
    const d = mailStore.getState().drafts[mailStore.getState().composeDraftId!];
    expect(d.to).toEqual([{ name: "Ada Lovelace", email: "ada@example.com" }]);
    expect(d.subject).toBe(`Re: ${a.subject}`);
    expect(d.thread_gmail_id).toBe(a.gmail_id);
  });
});

describe("default from", () => {
  function twoMailboxes(): void {
    mailStore.setState({
      accounts: {
        acct: { _id: "acct", _creationTime: 1, email: "me@example.com", provider: "demo", sync_status: "idle", updated_at: 0 },
        work: {
          _id: "work", _creationTime: 2, email: "me@work.com", provider: "demo", sync_status: "idle", updated_at: 0,
          send_as: [{ email: "me@work.com", is_default: true }, { email: "me@alias.com" }],
        },
      } as any,
    });
  }
  const draft = () => mailStore.getState().drafts[mailStore.getState().composeDraftId!];

  test("new mail starts from the chosen address, in any mailbox", () => {
    twoMailboxes();
    mailStore.getState().setClientPref("send_from", { account_id: "work", email: "me@alias.com" });
    mailStore.getState().startCompose("new");
    expect(draft().account_id).toBe("work");
    expect(draft().from).toBe("me@alias.com");
  });

  test("a mailbox scope wins over a default in another mailbox", () => {
    twoMailboxes();
    mailStore.getState().setClientPref("send_from", { account_id: "work", email: "me@alias.com" });
    mailStore.setState({ accountScope: "acct" });
    mailStore.getState().startCompose("new");
    expect(draft().account_id).toBe("acct");
    expect(draft().from).toBeUndefined();
  });

  test("an address the mailbox can no longer send as falls back to Gmail's default", () => {
    twoMailboxes();
    mailStore.getState().setClientPref("send_from", { account_id: "work", email: "gone@alias.com" });
    mailStore.getState().startCompose("new");
    expect(draft().account_id).toBe("acct");
    expect(draft().from).toBeUndefined();
  });
});

describe("drafts view", () => {
  // Drafts share the thread cursor: focusedThreadId holds a draft client id
  // while the Drafts view is active, so j/k/Enter/# work there unchanged.
  // Seeded directly: saveDraft stamps updated_at with the wall clock, and this
  // list is ordered BY that stamp — explicit values keep the order deterministic.
  function seedDrafts(n: number): string[] {
    const drafts: Record<string, Draft> = {};
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `draft-${i}`;
      ids.push(id);
      drafts[id] = {
        client_id: id,
        mode: "new",
        to: [],
        cc: [],
        bcc: [],
        subject: `D${i}`,
        body_text: "",
        updated_at: 100 + i,
      };
    }
    mailStore.setState({ drafts });
    mailStore.getState().setView("drafts");
    return ids;
  }

  test("j/k walk the drafts, newest first", () => {
    const [first, second, third] = seedDrafts(3);
    // Sorted by updated_at desc: third, second, first.
    expect(mailStore.getState().focusedThreadId).toBe(third);
    mailStore.getState().moveFocus(1);
    expect(mailStore.getState().focusedThreadId).toBe(second);
    mailStore.getState().moveFocus(1);
    expect(mailStore.getState().focusedThreadId).toBe(first);
    // Clamps at the end, then walks back up.
    mailStore.getState().moveFocus(1);
    expect(mailStore.getState().focusedThreadId).toBe(first);
    mailStore.getState().moveFocus(-1);
    expect(mailStore.getState().focusedThreadId).toBe(second);
    mailStore.getState().focusEdge("first");
    expect(mailStore.getState().focusedThreadId).toBe(third);
  });

  test("Enter opens the focused draft into compose", () => {
    const ids = seedDrafts(2);
    mailStore.getState().moveFocus(1);
    const focused = mailStore.getState().focusedThreadId;
    expect(focused).toBe(ids[0]);

    mailStore.getState().openFocused();
    const s = mailStore.getState();
    expect(s.composeDraftId).toBe(focused);
    expect(s.composeMinimized).toBe(false);
    // No thread was opened — the Drafts row has no reader.
    expect(s.openThreadId).toBeNull();
  });

  test("# discards the focused draft and moves the cursor down", () => {
    const [first, second, third] = seedDrafts(3);
    mailStore.getState().focusThread(second);

    mailStore.getState().trash();
    const s = mailStore.getState();
    expect(s.drafts[second]).toBeUndefined();
    expect(s.drafts[first]).toBeTruthy();
    expect(s.drafts[third]).toBeTruthy();
    // Cursor fell to the next-older row, mirroring archive in the thread list.
    expect(s.focusedThreadId).toBe(first);
    // No thread op ran: trashing a draft is a delete, not a relabel.
    expect(s.undoStack.length).toBe(0);
  });
});

describe("phone drawer", () => {
  test("any navigation from the drawer closes it; closing a panel does not", () => {
    const st = () => mailStore.getState();
    st().setNav(true);
    st().setView("starred");
    expect(st().navOpen).toBe(false);

    st().setNav(true);
    st().setAccountScope("acct");
    expect(st().navOpen).toBe(false);
    // Tapping the scope already shown still dismisses the drawer.
    st().setNav(true);
    st().setAccountScope("acct");
    expect(st().navOpen).toBe(false);

    st().setNav(true);
    st().setSearch(true);
    expect(st().navOpen).toBe(false);

    st().setNav(true);
    st().setSettings(true);
    expect(st().navOpen).toBe(false);

    st().setNav(true);
    st().setSettings(false);
    st().setSearch(false);
    expect(st().navOpen).toBe(true);
  });
});

describe("views", () => {
  test("setView reseats the cursor into the view", () => {
    const inboxT = serverThread([L.INBOX]);
    const starredT = serverThread([L.STARRED]);
    mailStore.getState().syncTable("threads", [inboxT, starredT]);
    mailStore.getState().setView("inbox");
    expect(mailStore.getState().focusedThreadId).toBe(inboxT._id);
    mailStore.getState().setView("starred");
    expect(mailStore.getState().focusedThreadId).toBe(starredT._id);
  });
});

describe("client preferences", () => {
  test("a preference patches its own key, so the dispatch envelope names a field", () => {
    const [next, patches] = create(
      { clientState: {} as Record<string, any> },
      (draft) => {
        applyClientPref(draft, "theme", "dark");
        applyClientPref(draft, "notifications", { enabled: false });
      },
      { enablePatches: true },
    );
    // The middleware that turns patches into a dispatch skips anything
    // shallower than <field, value>, so a whole-object replace never syncs.
    expect(patches.map((p) => p.path)).toEqual([
      ["clientState", "theme"],
      ["clientState", "notifications"],
    ]);
    expect(next.clientState).toEqual({ theme: "dark", notifications: { enabled: false } });
  });
});

describe("full search paging", () => {
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  test("pages on its own until a screen is full, then on request; rows land in the store", async () => {
    // Fifty hits, five per page: the store must keep asking until the list
    // shows a screenful, then stop and wait for the reader.
    const pages: Thread[][] = [];
    for (let p = 0; p < 10; p++) {
      pages.push(Array.from({ length: 5 }, () => serverThread([], { subject: "Wedding venue", last_at: 5 })));
    }
    const calls: Array<string | null> = [];
    setRemoteSearch(async (q, cursor) => {
      calls.push(cursor);
      const i = cursor ? Number(cursor) : 0;
      return { rows: pages[i], cursor: i + 1 < pages.length ? String(i + 1) : null };
    });
    try {
      mailStore.setState({ searchQuery: "wedding" });
      mailStore.getState().commitSearch();
      await settle();
      const s = mailStore.getState();
      expect(s.activeView).toBe("search:wedding");
      // 40 rows fill the screen: eight pages, no more on their own.
      expect(calls).toEqual([null, "1", "2", "3", "4", "5", "6", "7"]);
      expect(s.searchHits).toHaveLength(40);
      expect(Object.keys(s.threads)).toHaveLength(40);
      expect(s.searchHasMore).toBe(true);
      expect(s.searchStatus).toBe("idle");
      expect(s.focusedThreadId).toBe(pages[0][0]._id);

      mailStore.getState().loadMoreSearch();
      await settle();
      expect(calls).toHaveLength(9);
      expect(mailStore.getState().searchHits).toHaveLength(45);

      mailStore.getState().loadMoreSearch();
      await settle();
      expect(mailStore.getState().searchHits).toHaveLength(50);
      expect(mailStore.getState().searchHasMore).toBe(false);
      // Drained: another ask is a no-op.
      mailStore.getState().loadMoreSearch();
      await settle();
      expect(calls).toHaveLength(10);
    } finally {
      setRemoteSearch(null);
    }
  });

  test("a page that lands after the view moved on is dropped", async () => {
    let release: (() => void) | null = null;
    setRemoteSearch(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ rows: [serverThread([], { subject: "Wedding" })], cursor: "1" });
        }),
    );
    try {
      mailStore.setState({ searchQuery: "wedding" });
      mailStore.getState().commitSearch();
      expect(mailStore.getState().searchStatus).toBe("searching");
      mailStore.getState().setView("inbox");
      release!();
      await settle();
      const s = mailStore.getState();
      expect(s.searchHits).toEqual([]);
      expect(s.searchHasMore).toBe(false);
      expect(Object.keys(s.threads)).toHaveLength(0);
    } finally {
      setRemoteSearch(null);
    }
  });
});

describe("importance", () => {
  test("- moves the cursor's thread to Other and seats the cursor on the next row", () => {
    const a = serverThread([L.INBOX]);
    const b = serverThread([L.INBOX], { important: true, important_by: "ai", important_why: "Ada asks" });
    const c = serverThread([L.INBOX]);
    mailStore.getState().syncTable("threads", [a, b, c]);
    mailStore.getState().focusThread(b._id);

    mailStore.getState().markImportant(false);

    const s = mailStore.getState();
    expect(s.threads[b._id]).toMatchObject({ important: false, important_by: "user" });
    expect(s.threads[b._id].important_why).toBeUndefined();
    expect(s.focusedThreadId).toBe(a._id);
  });

  test("a server echo does not undo a hand mark", () => {
    const a = serverThread([L.INBOX], { important: true, important_by: "ai" });
    mailStore.getState().syncTable("threads", [a]);
    mailStore.getState().markImportant(false, [a._id]);
    mailStore.getState().syncTable("threads", [{ ...a, updated_at: a.updated_at + 1 }]);
    expect(mailStore.getState().threads[a._id].important).toBe(false);
  });

  test("saving the policy bumps the revision, and the default saves as no policy", () => {
    mailStore.getState().setImportancePolicy({ policy: "Only my sister" });
    expect(mailStore.getState().clientState.importance).toEqual({ policy: "Only my sister", revision: 1 });
    mailStore.getState().setImportancePolicy({ policy: DEFAULT_IMPORTANCE_POLICY });
    expect(mailStore.getState().clientState.importance).toEqual({ policy: undefined, revision: 2 });
  });
});
