import React, { useEffect, useMemo, useState } from "react";
import { useTracked } from "../store/mailStore";
import { CATEGORIES } from "@mail/shared/src/lib/categories";
import type { CategoryId } from "@mail/shared/src/lib/categories";
import { orderedAccounts } from "../store/selectors";
import type { Account, Thread } from "../store/types";
import {
  askNotificationPermission,
  describeLevel,
  describePermission,
  inQuietHours,
  openOsNotificationSettings,
  osNotifyState,
  previewNotifications,
  setNotificationPrefs,
  setSenderRule,
  useNotificationPrefs,
  type BadgeMode,
  type NotifyLevel,
  type OsNotifyState,
  type PreviewLevel,
} from "../lib/notifications";
import { sendTestNotification } from "../lib/notifier";
import { useMailStore } from "../store/mailStore";

// The rules for who may interrupt you. Every control here answers a question
// someone actually asks about mail notifications — what gets through, from
// whom, when, and how loudly — and the panel shows what the answers add up to
// against your real inbox instead of making you find out at 2am.

/**
 * Where the notification is stopped, and the one thing to press about it.
 *
 * The system's answer comes first because nothing below matters while it says
 * no — and it is read from the OS rather than assumed, since a browser (and
 * Electron's copy of one) reports "granted" whether or not anything is ever
 * drawn on screen.
 */
function PermissionCard({
  state,
  checking,
  onRecheck,
}: {
  state: OsNotifyState;
  checking: boolean;
  onRecheck: (next: OsNotifyState) => void;
}): React.ReactElement | null {
  const copy = describePermission(state, "Whisk");
  if (state === "unsupported") return null;
  // Working and proven: one quiet line, no card, nothing to do.
  if (copy.tone === "ok") {
    return (
      <p className="nt-perm-ok">
        <span className="nt-perm-tick" aria-hidden />
        {copy.title}
        {copy.canOpenSettings && (
          <button className="rail-hint-link nt-perm-quiet" onClick={() => openOsNotificationSettings()}>
            System settings
          </button>
        )}
      </p>
    );
  }
  return (
    <div className={`nt-perm is-${copy.tone}`} role={copy.tone === "warn" ? "alert" : undefined}>
      <div className="nt-perm-body">
        <div className="nt-perm-title">{copy.title}</div>
        {copy.body && <div className="nt-perm-text">{copy.body}</div>}
      </div>
      <div className="nt-perm-actions">
        {copy.canAsk && (
          <button
            className="settings-btn is-primary"
            onClick={() => void askNotificationPermission().then(onRecheck)}
          >
            Allow notifications
          </button>
        )}
        {copy.canOpenSettings && (
          <button className="settings-btn is-primary" onClick={() => openOsNotificationSettings()}>
            Open system settings
          </button>
        )}
        {copy.canTest && (
          <button
            className="settings-btn"
            disabled={checking}
            onClick={() => void osNotifyState({ refresh: true }).then(onRecheck)}
          >
            {checking ? "Checking…" : "Check again"}
          </button>
        )}
      </div>
    </div>
  );
}

function Switch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`nt-switch${on ? " is-on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="nt-switch-knob" />
    </button>
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string; hint?: string }[];
  onChange: (next: T) => void;
}): React.ReactElement {
  return (
    <div className="nt-choice" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={`nt-choice-item${value === o.id ? " is-on" : ""}`}
          onClick={() => onChange(o.id)}
        >
          <span className="nt-choice-label">{o.label}</span>
          {o.hint && <span className="nt-choice-hint">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

function SenderList({
  title,
  hint,
  entries,
  onAdd,
  onRemove,
}: {
  title: string;
  hint: string;
  entries: string[];
  onAdd: (email: string) => void;
  onRemove: (email: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    onAdd(draft);
    setDraft("");
  };
  return (
    <div className="nt-people">
      <div className="nt-people-head">
        <span className="nt-label">{title}</span>
        <span className="nt-hint">{hint}</span>
      </div>
      <div className="nt-chips">
        {entries.map((e) => (
          <span key={e} className="compose-chip nt-chip">
            {e}
            <button className="compose-chip-x" onClick={() => onRemove(e)} aria-label={`Remove ${e}`}>
              ×
            </button>
          </span>
        ))}
        {entries.length === 0 && <span className="nt-empty">Nobody yet</span>}
      </div>
      <form className="nt-add" onSubmit={submit}>
        <input
          className="nt-input"
          value={draft}
          placeholder="name@example.com or @example.com"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="settings-btn" type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];

export function NotificationSettings(): React.ReactElement {
  const prefs = useNotificationPrefs();
  const s = useTracked([(s) => s.accounts, (s) => s.threads]);
  const accounts = orderedAccounts(s.accounts) as Account[];
  const [permission, setPermission] = useState<OsNotifyState>("unknown");
  const [checking, setChecking] = useState(true);
  // Ask the system what it is doing with our notifications whenever this
  // panel opens. On desktop that reads the OS's own record of how it
  // presented the last one — a few seconds, and nothing is posted.
  useEffect(() => {
    let live = true;
    setChecking(true);
    void osNotifyState({ refresh: true }).then((s) => {
      if (!live) return;
      setPermission(s);
      setChecking(false);
    });
    return () => {
      live = false;
    };
  }, []);

  const recheck = (next: OsNotifyState) => {
    setPermission(next);
    setChecking(false);
  };

  // A pause ends on its own; tick so the panel stops claiming to be paused.
  const [, tick] = useState(0);
  const pausedUntil = prefs.pausedUntil;
  useEffect(() => {
    if (!pausedUntil || pausedUntil <= Date.now()) return;
    const id = setTimeout(() => tick((n) => n + 1), pausedUntil - Date.now() + 250);
    return () => clearTimeout(id);
  }, [pausedUntil]);
  const now = new Date();

  // What the rules would have done to the mail you already have. The honest
  // answer to "so what actually reaches me?", before the next thing arrives.
  const preview = useMemo(
    () =>
      previewNotifications(Object.values(s.threads) as Thread[], {
        prefs,
        accountOf: (id) => s.accounts[id],
        now,
      }),
    [s.threads, s.accounts, prefs],
  );

  const set = setNotificationPrefs;
  const quietNow = inQuietHours(now, prefs.quiet);
  const paused = !!prefs.pausedUntil && prefs.pausedUntil > now.getTime();
  const off = !prefs.enabled;
  const pause = (minutes: number) => set({ pausedUntil: Date.now() + minutes * 60_000 });

  const test = async () => {
    setChecking(true);
    const r = await sendTestNotification();
    setPermission(r.state);
    setChecking(false);
    useMailStore
      .getState()
      .pushToast(r.ok ? "Sent — your system showed it" : r.reason!, r.ok ? "info" : "error");
  };

  return (
    <section className="settings-section">
      <h3 className="help-group-title">Notifications</h3>

      <div className="settings-row nt-master">
        <div>
          <div className="nt-master-title">New mail banners</div>
          <div className={`nt-master-sub${paused ? " is-paused" : ""}`}>
            {describeLevel(prefs, now.getTime())}
          </div>
        </div>
        <div className="nt-master-actions">
          {paused ? (
            <button className="settings-btn is-primary" onClick={() => set({ pausedUntil: undefined })}>
              Resume now
            </button>
          ) : (
            <div className="nt-pause">
              <span className="nt-pause-label">Pause</span>
              {[30, 60, 240].map((m) => (
                <button key={m} className="nt-pause-btn" onClick={() => pause(m)} disabled={off}>
                  {m < 60 ? `${m}m` : `${m / 60}h`}
                </button>
              ))}
            </div>
          )}
          <button className="settings-btn is-quiet" onClick={() => void test()} disabled={off || checking}>
            {checking ? "Checking…" : "Try one"}
          </button>
          <Switch on={prefs.enabled} onChange={(enabled) => set({ enabled })} label="Notifications" />
        </div>
      </div>

      <PermissionCard state={permission} checking={checking} onRecheck={recheck} />

      <fieldset className="nt-body" disabled={off}>
        <div className="nt-block">
          <span className="nt-label">What gets through</span>
          <Choice<NotifyLevel>
            value={prefs.level}
            onChange={(level) => set({ level })}
            options={[
              { id: "all", label: "Everything", hint: "Every thread that lands in the inbox" },
              { id: "primary", label: "Primary", hint: "Real correspondence; filed lanes stay quiet" },
              { id: "vip", label: "Important only", hint: "Just the senders you name below" },
              { id: "none", label: "Nothing", hint: "Badge and list only" },
            ]}
          />
          <p className="nt-preview">
            {preview.sampled === 0 ? (
              "No mail here yet to measure against."
            ) : (
              <>
                Of your last {preview.sampled} inbox threads,{" "}
                <strong>{preview.passed}</strong> would have interrupted you
                {preview.blocked.quiet ? ` · ${preview.blocked.quiet} held by quiet hours` : ""}
                {preview.blocked.muted ? ` · ${preview.blocked.muted} muted` : ""}.
              </>
            )}
          </p>
        </div>

        {(prefs.level === "all" || prefs.level === "primary") && (
          <div className="nt-block">
            <span className="nt-label">Lanes</span>
            <span className="nt-hint">
              Whisk files mail into lanes. Turn one on to hear about it, off to never.
            </span>
            <div className="nt-lanes">
              {CATEGORIES.map((c) => {
                const override = prefs.lanes[c.id as CategoryId];
                const on = override ?? prefs.level === "all";
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    className={`nt-lane${on ? " is-on" : ""}`}
                    style={{ ["--hue" as any]: c.hue }}
                    onClick={() =>
                      set((p) => ({ ...p, lanes: { ...p.lanes, [c.id]: !on } }))
                    }
                  >
                    <span className="nt-lane-dot" aria-hidden />
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="nt-block nt-two">
          <SenderList
            title="Always interrupt me"
            hint="Through lanes, quiet hours, everything"
            entries={prefs.vips}
            onAdd={(e) => setSenderRule(e, "vip")}
            onRemove={(e) => setSenderRule(e, "none")}
          />
          <SenderList
            title="Never interrupt me"
            hint="Beats every other rule here"
            entries={prefs.muted}
            onAdd={(e) => setSenderRule(e, "muted")}
            onRemove={(e) => setSenderRule(e, "none")}
          />
        </div>

        <div className="nt-block">
          <div className="nt-block-head">
            <div>
              <span className="nt-label">Quiet hours</span>
              <span className="nt-hint">
                {quietNow && prefs.quiet.enabled ? "Quiet right now" : "Nothing lands during these hours"}
              </span>
            </div>
            <Switch
              on={prefs.quiet.enabled}
              onChange={(enabled) => set((p) => ({ ...p, quiet: { ...p.quiet, enabled } }))}
              label="Quiet hours"
            />
          </div>
          {prefs.quiet.enabled && (
            <div className="nt-quiet">
              <label className="nt-time">
                From
                <input
                  type="time"
                  className="nt-input"
                  value={prefs.quiet.from}
                  onChange={(e) => set((p) => ({ ...p, quiet: { ...p.quiet, from: e.target.value } }))}
                />
              </label>
              <label className="nt-time">
                To
                <input
                  type="time"
                  className="nt-input"
                  value={prefs.quiet.to}
                  onChange={(e) => set((p) => ({ ...p, quiet: { ...p.quiet, to: e.target.value } }))}
                />
              </label>
              <div className="nt-days">
                {DAYS.map((d, i) => {
                  const on = prefs.quiet.days.length === 0 || prefs.quiet.days.includes(i);
                  return (
                    <button
                      key={i}
                      type="button"
                      aria-pressed={on}
                      aria-label={`Day ${i}`}
                      className={`nt-day${on ? " is-on" : ""}`}
                      onClick={() =>
                        set((p) => {
                          // An empty list means every day; the first click has
                          // to spell that out before it can remove one.
                          const cur = p.quiet.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : p.quiet.days;
                          const next = cur.includes(i) ? cur.filter((n) => n !== i) : [...cur, i].sort();
                          return { ...p, quiet: { ...p.quiet, days: next.length === 7 ? [] : next } };
                        })
                      }
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
              <label className="nt-check">
                <input
                  type="checkbox"
                  checked={prefs.quiet.allowVip}
                  onChange={(e) => set((p) => ({ ...p, quiet: { ...p.quiet, allowVip: e.target.checked } }))}
                />
                Let the senders above through anyway
              </label>
            </div>
          )}
        </div>

        <div className="nt-block">
          <span className="nt-label">How they arrive</span>
          <div className="nt-rows">
            <div className="nt-row">
              <span>Sound</span>
              <Switch on={prefs.sound} onChange={(sound) => set({ sound })} label="Sound" />
            </div>
            <div className="nt-row">
              <span>Show a banner even while Whisk is open</span>
              <Switch
                on={prefs.whenFocused}
                onChange={(whenFocused) => set({ whenFocused })}
                label="Notify while focused"
              />
            </div>
            <div className="nt-row nt-row-stack">
              <span>How much the banner says</span>
              <Choice<PreviewLevel>
                value={prefs.preview}
                onChange={(preview) => set({ preview })}
                options={[
                  { id: "full", label: "Sender and subject" },
                  { id: "sender", label: "Sender only" },
                  { id: "none", label: "Nothing" },
                ]}
              />
            </div>
            <div className="nt-row nt-row-stack">
              <span>Dock badge counts</span>
              <Choice<BadgeMode>
                value={prefs.badge}
                onChange={(badge) => set({ badge })}
                options={[
                  { id: "primary", label: "Primary unread" },
                  { id: "inbox", label: "All inbox unread" },
                  { id: "none", label: "Nothing" },
                ]}
              />
            </div>
          </div>
        </div>

        {accounts.length > 1 && (
          <div className="nt-block">
            <span className="nt-label">Mailboxes</span>
            <div className="nt-rows">
              {accounts.map((a) => (
                <div className="nt-row" key={a._id}>
                  <span>{a.email}</span>
                  <Switch
                    on={prefs.accounts[a._id] !== false}
                    onChange={(on) => set((p) => ({ ...p, accounts: { ...p.accounts, [a._id]: on } }))}
                    label={a.email}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </fieldset>
    </section>
  );
}
