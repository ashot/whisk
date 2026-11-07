import React, { useMemo, useState } from "react";
import { keyEngine } from "../keys/engine";
import { activeContext, calendarCommand } from "../keys/bindings";
import { useMailStore, useTracked } from "../store/mailStore";
import { CATEGORIES } from "@mail/shared/src/lib/categories";
import type { Label } from "../store/types";
import { inScope, inboxGrouping, inboxLenses, isInboxList, lensView } from "../store/selectors";
import { signOut } from "../sync/ConvexSync";
import { toggleTheme } from "../lib/theme";
import {
  formatClock,
  notificationPrefs,
  senderRule,
  setNotificationPrefs,
  setSenderRule,
} from "../lib/notifications";
import { threadSender } from "../lib/notifier";
import { KeyCap } from "./KeyCap";
import { useRestoreFocus } from "../lib/useRestoreFocus";

type Item = {
  id: string;
  title: string;
  hint?: string;
  keys?: string;
  run: () => void;
};

function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 - t.indexOf(q);
  let qi = 0;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      score += 2;
    }
  }
  return qi === q.length ? score : -1;
}

export function Palette(): React.ReactElement {
  // openThreadId is a dep because the command list is context-dependent: the
  // bindings offered differ between the list and an open thread.
  const s = useTracked([(s) => s.labels, (s) => s.openThreadId, (s) => s.activeView]);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  useRestoreFocus();

  const items = useMemo<Item[]>(() => {
    const st = useMailStore.getState();
    const calendar = st.activeView === "calendar" && !st.openThreadId;
    const ctx = calendar ? "settings" : st.openThreadId ? "thread" : "list";
    const fromKeys: Item[] = (calendar ? [] : keyEngine
      .activeFor(ctx)
      .filter((b) => !b.hidden)
      .map((b) => ({
        id: `key:${b.keys}`,
        title: b.description,
        hint: b.group,
        keys: b.keys,
        run: b.handler,
      })));
    const labels: Item[] = (Object.values(s.labels) as Label[])
      .filter((l) => l.kind === "user" && !l.deleted)
      .map((l) => ({
        id: `label:${l.gmail_id}`,
        title: `Go to label: ${l.name}`,
        hint: "Go to",
        run: () => st.setView(`label:${l.gmail_id}`),
      }));
    const lanes: Item[] = [
      ...CATEGORIES.map((c) => ({
        id: `lane:${c.id}`,
        title: `Go to lane: ${c.id === "calendar" ? "Invitation emails" : c.name}`,
        hint: "Go to",
        run: () => st.setView(`cat:${c.id}`),
      })),
      {
        id: "lane:primary",
        title: "Go to lane: Primary",
        hint: "Go to",
        run: () => st.setView("cat:primary"),
      },
    ];
    // Notification rules, aimed at what is in front of you.
    const prefs = notificationPrefs();
    const paused = !!prefs.pausedUntil && prefs.pausedUntil > Date.now();
    const openThread = st.openThreadId ? st.threads[st.openThreadId] : null;
    const sender = openThread ? threadSender(openThread) : null;
    const rule = sender ? senderRule(sender, prefs) : "none";
    const pause = (minutes: number) => ({
      id: `notify:pause:${minutes}`,
      title: `Pause notifications for ${minutes < 60 ? `${minutes} minutes` : minutes === 60 ? "an hour" : `${minutes / 60} hours`}`,
      hint: "Notifications",
      run: () => {
        const until = Date.now() + minutes * 60_000;
        setNotificationPrefs({ pausedUntil: until });
        st.pushToast(`Notifications paused until ${formatClock(new Date(until))}`);
      },
    });
    const notify: Item[] = [
      ...(paused
        ? [
            {
              id: "notify:resume",
              title: "Resume notifications",
              hint: "Notifications",
              run: () => {
                setNotificationPrefs({ pausedUntil: undefined });
                st.pushToast("Notifications back on");
              },
            },
          ]
        : [pause(30), pause(60), pause(240)]),
      ...(sender
        ? [
            {
              id: "notify:vip",
              title:
                rule === "vip"
                  ? `Stop always interrupting me for ${sender}`
                  : `Always interrupt me for ${sender}`,
              hint: "Notifications",
              run: () => {
                setSenderRule(sender, rule === "vip" ? "none" : "vip");
                st.pushToast(rule === "vip" ? `${sender} is no longer important` : `${sender} will always interrupt you`);
              },
            },
            {
              id: "notify:mute",
              title: rule === "muted" ? `Unmute notifications from ${sender}` : `Never notify me about ${sender}`,
              hint: "Notifications",
              run: () => {
                setSenderRule(sender, rule === "muted" ? "none" : "muted");
                st.pushToast(rule === "muted" ? `${sender} unmuted` : `Muted ${sender}`);
              },
            },
          ]
        : []),
      {
        id: "notify:settings",
        title: "Notification rules — lanes, senders, quiet hours",
        hint: "Notifications",
        run: () => st.setSettings(true),
      },
    ];
    const whisk: Item[] = [
      { id: "whisk:filters", title: "Filters — tell Whisk what to find and what to do", hint: "Whisk", run: () => st.setFilters(true) },
      { id: "whisk:newlens", title: "New view — describe what belongs in it", hint: "Whisk", run: () => { if (!isInboxList(st.activeView)) st.setView("inbox"); st.setLensPanel("new"); } },
      { id: "whisk:tunelens", title: "Tune this list — its description and how much it shows", hint: "Whisk", run: () => { if (!isInboxList(st.activeView)) st.setView("inbox"); st.setLensPanel("tune"); } },
      ...inboxLenses(st).map((l) => ({ id: `lens:${l.id}`, title: `Go to ${l.name}`, hint: "i", run: () => st.setView(lensView(l.id)) })),
      { id: "whisk:other", title: "Go to Other — the rest of the inbox", hint: "i", run: () => st.setView("other") },
      ...(Object.values(st.clusters).some((c) => !c.deleted)
        ? [inboxGrouping(st).grouped
          ? { id: "whisk:flat", title: "Inbox as a plain list", hint: "v", run: () => { st.setInboxGrouped(false); st.setView("inbox"); } }
          : { id: "whisk:grouped", title: "Inbox as topics", hint: "v", run: () => { st.setInboxGrouped(true); st.setView("inbox"); } }]
        : []),
      ...(Object.values(st.accounts).filter((a) => inScope({ account_id: a._id }, st.accountScope)).some((a) => a.clustering) || (st.clientState.prefs?.clustering as { enabled?: boolean } | undefined)?.enabled === false
        ? []
        : [{ id: "whisk:regroup", title: "Regroup topics — rediscover from scratch, keep what you named and placed", hint: "Whisk", run: () => { for (const a of Object.values(st.accounts)) if (inScope({ account_id: a._id }, st.accountScope)) st.regroupClusters({ fresh: true, account_id: a._id }); st.setInboxGrouped(true); st.setView("inbox"); } }]),
      {
        id: "whisk:memories",
        title: "Memories — what Whisk knows about you",
        hint: "Whisk",
        run: () => st.setMemories(true),
      },
    ];
    const theme: Item[] = [
      {
        id: "theme:toggle",
        title: "Toggle light / dark theme",
        hint: "Appearance",
        run: () => toggleTheme(),
      },
    ];
    const session: Item[] = [
      {
        id: "settings:open",
        title: "Settings — accounts, sync, appearance",
        hint: "Account",
        keys: "mod+,",
        run: () => st.setSettings(true),
      },
      {
        id: "session:signout",
        title: "Sign out on this device",
        hint: "Account",
        run: () => void signOut(),
      },
    ];
    const calendarItems: Item[] = calendar ? [
      { id: "calendar:new", title: "New calendar event", keys: "n", run: () => calendarCommand("new") },
      { id: "calendar:today", title: "Jump to today", keys: "t", run: () => calendarCommand("today") },
      { id: "calendar:inbox", title: "Go to inbox", keys: "g i", run: () => st.setView("inbox") },
    ] : [];
    return [...calendarItems, ...fromKeys, ...notify, ...whisk, ...lanes, ...labels, ...theme, ...session];
  }, [s.labels, s.openThreadId, s.activeView]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    return items
      .map((item) => ({ item, score: fuzzyScore(query, item.title) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item);
  }, [items, query]);

  // Navigation and rendering use the SAME capped list, so the cursor can never
  // land on an item that isn't drawn (the old code navigated the full list but
  // rendered only 12 — Enter could run an invisible command).
  const MAX_VISIBLE = 12;
  const visible = filtered.slice(0, MAX_VISIBLE);
  const active = Math.min(index, Math.max(visible.length - 1, 0));
  const close = () => useMailStore.getState().setPalette(false);

  return (
    <div className="overlay" onClick={close}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          value={query}
          placeholder="Type a command…"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, visible.length - 1));
            } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const item = visible[active];
              if (item) {
                close();
                item.run();
              }
            }
          }}
        />
        <div className="palette-list">
          {visible.length === 0 && <div className="palette-empty">No commands match.</div>}
          {visible.map((item, i) => (
            <button
              key={item.id}
              className={`palette-item${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                close();
                item.run();
              }}
            >
              <span className="palette-item-title">{item.title}</span>
              <span className="palette-item-hint">{item.hint}</span>
              {item.keys && <KeyCap spec={item.keys} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
