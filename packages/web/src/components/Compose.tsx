import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { draftsIn, orderedAccounts } from "../store/selectors";
import { suggestRecipients, type Contact } from "@mail/shared/src/store/contacts";
import { ghostKeyAction } from "@mail/shared/src/lib/composeGhost";
import { outgoingKey, previewKind } from "@mail/shared/src/lib/attachments";
import { aiAvailable, aiClient } from "@mail/shared/src/store/aiBridge";
import { fromAddress, sendAddresses } from "@mail/shared/src/lib/sendAs";
import { addRecipients, composeLabels, parseAddresses } from "@mail/shared/src/lib/compose";
import type { Account, Address, Draft, OutgoingAttachment } from "../store/types";
import { formatSize } from "../lib/format";
import {
  attachToCompose,
  getComposePreview,
  handleComposePaste,
  removeComposeFile,
  retryComposeFile,
  sendComposeReady,
  useComposePending,
} from "../lib/composeAttach";
import { attachmentUrl } from "../sync/ConvexSync";
import { KeyCap } from "./KeyCap";

function AddressField({
  label,
  value,
  onChange,
  autoFocus,
  inputRef,
  trailing,
}: {
  label: string;
  value: Address[];
  onChange: (a: Address[]) => void;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** Controls seated at the field's right edge (the Cc / Bcc reveals). */
  trailing?: React.ReactNode;
}): React.ReactElement {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const hits = suggestRecipients(useMailStore.getState(), text, value);
  const open = hits.length > 0;
  const add = (added: Address[]) => {
    const next = addRecipients(value, added);
    if (next !== value) onChange(next);
    setText("");
    setActive(0);
  };
  const pick = (c: Contact) => add([c.name ? { name: c.name, email: c.email } : { email: c.email }]);
  const commit = () => {
    const { addresses } = parseAddresses(text);
    if (addresses.length > 0) add(addresses);
  };
  return (
    <div className="compose-field">
      <span className="compose-field-label">{label}</span>
      <div className="compose-chips">
        {value.map((a) => (
          <span key={a.email} className="compose-chip" title={a.email}>
            {a.name ?? a.email}
            <button
              className="compose-chip-x"
              tabIndex={-1}
              onClick={() => onChange(value.filter((v) => v.email !== a.email))}
            >
              ×
            </button>
          </span>
        ))}
        <span className="compose-chip-slot">
          <input
            ref={inputRef}
            className="compose-chip-input"
            value={text}
            autoFocus={autoFocus}
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            onChange={(e) => {
              setText(e.target.value);
              setActive(0);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (open && e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => (i + 1) % hits.length);
              } else if (open && e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => (i - 1 + hits.length) % hits.length);
              } else if (open && e.key === "Escape") {
                // Close the list, not the composer.
                e.preventDefault();
                e.stopPropagation();
                setText("");
              } else if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
                if (open && (e.key !== "Tab" || !e.shiftKey)) {
                  e.preventDefault();
                  pick(hits[active]);
                } else if (text.trim()) {
                  e.preventDefault();
                  commit();
                }
              } else if (e.key === "Backspace" && !text && value.length > 0) {
                onChange(value.slice(0, -1));
              }
            }}
            placeholder={value.length === 0 ? "name@example.com" : ""}
          />
          {open && (
            <ul className="compose-suggest" role="listbox">
              {hits.map((c, i) => (
                <li
                  key={c.email}
                  role="option"
                  aria-selected={i === active}
                  className={`compose-suggest-row${i === active ? " is-active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  // mousedown, so the input's blur (which commits raw text)
                  // never runs first and swallows the click.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(c);
                  }}
                >
                  {c.name ? (
                    <>
                      <span className="compose-suggest-name">{c.name}</span>
                      <span className="compose-suggest-email">{c.email}</span>
                    </>
                  ) : (
                    <span className="compose-suggest-name">{c.email}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </span>
      </div>
      {trailing}
    </div>
  );
}

/** Every field above the body: who it is from, who it goes to, what it is
 *  about. The floating composer shows this in place; an inline reply shows
 *  it in a popover (⌘E). One component, so the two can never disagree. */
function HeaderFields({
  draft,
  autoFocusTo,
  toRef,
}: {
  draft: Draft;
  autoFocusTo?: boolean;
  toRef?: React.RefObject<HTMLInputElement | null>;
}): React.ReactElement {
  const st = useMailStore.getState();
  // To and Subject are the header. Cc and Bcc appear together behind one
  // link, and stay once either holds an address.
  const [more, setMore] = useState(false);
  const extra = more || draft.cc.length > 0 || draft.bcc.length > 0;
  return (
    <>
      <FromLine draft={draft} onChange={(fields) => st.updateComposeDraft(fields)} />
      <AddressField
        label="To"
        value={draft.to}
        autoFocus={autoFocusTo}
        inputRef={toRef}
        onChange={(to) => st.updateComposeDraft({ to })}
        trailing={
          !extra && (
            <button className="compose-more" tabIndex={-1} onClick={() => setMore(true)}>
              Cc/Bcc
            </button>
          )
        }
      />
      {extra && <AddressField label="Cc" value={draft.cc} onChange={(cc) => st.updateComposeDraft({ cc })} />}
      {extra && <AddressField label="Bcc" value={draft.bcc} onChange={(bcc) => st.updateComposeDraft({ bcc })} />}
      <div className="compose-field">
        <input
          className="compose-subject"
          value={draft.subject}
          placeholder="Subject"
          onChange={(e) => st.updateComposeDraft({ subject: e.target.value })}
        />
      </div>
    </>
  );
}

/** The popover over an inline reply: the same header fields, on demand. */
function HeadPopover({ draft }: { draft: Draft }): React.ReactElement {
  const st = useMailStore.getState();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) st.setComposeHeadOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);
  return (
    <div
      ref={ref}
      className="compose-head-pop"
      role="dialog"
      aria-label="Recipients and subject"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          st.setComposeHeadOpen(false);
        }
      }}
    >
      <HeaderFields draft={draft} autoFocusTo />
      <div className="compose-head-pop-foot">
        <button className="compose-head-pop-done" onClick={() => st.setComposeHeadOpen(false)}>
          Done <KeyCap spec="esc" />
        </button>
      </div>
    </div>
  );
}

/** The address a draft goes out from: any address of any mailbox for fresh
 *  mail, the thread's mailbox's own addresses for a reply or forward (it
 *  lands in that mailbox's thread). Hidden when there is only one to pick. */
function FromLine({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (fields: Pick<Draft, "account_id" | "from">) => void;
}): React.ReactElement | null {
  const all = orderedAccounts(useMailStore.getState().accounts) as Account[];
  const account = (draft.account_id && all.find((a) => a._id === draft.account_id)) || all[0];
  if (!account) return null;
  const accounts = draft.mode === "new" ? all : [account];
  if (accounts.flatMap(sendAddresses).length <= 1) return null;
  return (
    <div className="compose-field compose-from">
      <span className="compose-field-label">From</span>
      <FromPicker
        className="compose-from-select"
        accounts={accounts}
        account={account}
        email={fromAddress(account, draft.from).email}
        onPick={(a, email) => onChange({ account_id: a._id, from: email })}
      />
    </div>
  );
}

/** Every address of the given mailboxes, one option each. Compose picks a
 *  draft's From with it, Settings the default for new mail. */
export function FromPicker({
  accounts,
  account,
  email,
  onPick,
  className,
}: {
  accounts: Account[];
  account: Account;
  email: string;
  onPick: (account: Account, email: string) => void;
  className?: string;
}): React.ReactElement {
  const choices = accounts.flatMap((a) => sendAddresses(a).map((addr) => ({ account: a, addr })));
  const key = (accountId: string, address: string) => `${accountId} ${address}`;
  return (
    <select
      className={className}
      value={key(account._id, email)}
      onChange={(e) => {
        const pick = choices.find((c) => key(c.account._id, c.addr.email) === e.target.value);
        if (pick) onPick(pick.account, pick.addr.email);
      }}
    >
      {choices.map(({ account: a, addr }) => (
        <option key={key(a._id, addr.email)} value={key(a._id, addr.email)}>
          {addr.name ? `${addr.name} <${addr.email}>` : addr.email}
        </option>
      ))}
    </select>
  );
}

function fileExtension(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toUpperCase() : "FILE";
}

function previewForOutgoing(a: OutgoingAttachment): string | undefined {
  const blob = getComposePreview(outgoingKey(a));
  if (blob) return blob;
  if (a.message_gmail_id && a.gmail_attachment_id && previewKind(a) === "image") {
    return (
      attachmentUrl(a.message_gmail_id, {
        attachment: {
          filename: a.filename,
          mime_type: a.mime_type,
          size: a.size,
          gmail_attachment_id: a.gmail_attachment_id,
        },
      }) ?? undefined
    );
  }
  return undefined;
}

function ClipIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13 6.2 7.1 12a2.9 2.9 0 0 1-4.1-4.1l6.4-6.4a1.95 1.95 0 0 1 2.8 2.8L5.8 10.7a1 1 0 0 1-1.4-1.4l5.7-5.7" />
    </svg>
  );
}

function ComposeChip({
  filename,
  mime_type,
  size,
  status,
  preview_url,
  onRemove,
  onRetry,
}: {
  filename: string;
  mime_type: string;
  size: number;
  status: "ready" | "uploading" | "error";
  preview_url?: string;
  onRemove: () => void;
  onRetry?: () => void;
}): React.ReactElement {
  const kind = previewKind({ mime_type, filename });
  return (
    <div className={`attachment-chip compose-file is-${status}`}>
      <span className="attachment-main">
        {kind === "image" && preview_url ? (
          <img className="attachment-thumb" src={preview_url} alt="" />
        ) : (
          <span className="attachment-glyph" data-kind={kind}>
            {fileExtension(filename)}
          </span>
        )}
        <span className="attachment-text">
          <span className="attachment-name">{filename}</span>
          <span className="attachment-size">
            {formatSize(size)}
            {status === "uploading" && <span className="attachment-dot" aria-label="attaching" />}
            {status === "error" && <span className="attachment-err">not attached</span>}
          </span>
        </span>
      </span>
      {onRetry && (
        <button type="button" className="attachment-action" tabIndex={-1} onClick={onRetry}>
          Retry
        </button>
      )}
      <button type="button" className="compose-file-x" tabIndex={-1} title="Remove" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

function ComposeFiles({ draft }: { draft: Draft }): React.ReactElement | null {
  const pending = useComposePending(draft.client_id);
  const ready = draft.attachments ?? [];
  if (ready.length === 0 && pending.length === 0) return null;
  return (
    <div className="compose-files" aria-label="Attached files">
      {ready.map((a) => (
        <ComposeChip
          key={outgoingKey(a)}
          filename={a.filename}
          mime_type={a.mime_type}
          size={a.size}
          status="ready"
          preview_url={previewForOutgoing(a)}
          onRemove={() => removeComposeFile(draft.client_id, outgoingKey(a))}
        />
      ))}
      {pending.map((p) => (
        <ComposeChip
          key={p.local_id}
          filename={p.filename}
          mime_type={p.mime_type}
          size={p.size}
          status={p.status}
          preview_url={p.preview_url}
          onRemove={() => removeComposeFile(draft.client_id, p.local_id)}
          onRetry={p.status === "error" ? () => retryComposeFile(draft.client_id, p.local_id) : undefined}
        />
      ))}
    </div>
  );
}

function AttachButton(): React.ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="compose-attach"
        title="Attach files"
        tabIndex={-1}
        onClick={() => ref.current?.click()}
      >
        <ClipIcon />
      </button>
      <input
        ref={ref}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void attachToCompose(files);
        }}
      />
    </>
  );
}

function ComposeFoot(): React.ReactElement {
  return (
    <footer className="compose-foot">
      <button className="compose-send" onClick={() => void sendComposeReady()}>
        Send <KeyCap spec="cmd+enter" />
      </button>
      <AttachButton />
      <span className="compose-foot-hint">
        <KeyCap spec="tab" /> use suggestion · draft saves as you type
      </span>
    </footer>
  );
}

const suggestCache = new Map<string, string[]>();
const suggestInflight = new Map<string, Promise<string[]>>();

function loadSuggestions(threadGmailId: string, accountId?: string): Promise<string[]> {
  const key = `${accountId ?? ""}:${threadGmailId}`;
  const hit = suggestCache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = suggestInflight.get(key);
  if (pending) return pending;
  if (!aiAvailable()) return Promise.resolve([]);
  const p = aiClient()
    .suggestReplies({ threadGmailId, accountId })
    .then((r) => {
      suggestCache.set(key, r.suggestions);
      suggestInflight.delete(key);
      return r.suggestions;
    })
    .catch(() => {
      suggestInflight.delete(key);
      return [] as string[];
    });
  suggestInflight.set(key, p);
  return p;
}

/** Body textarea plus the AI busy shimmer and the empty-box ghost
 *  (Codecast: predicted replies, Tab to take one, gone the moment you type). */
function ComposeBody({
  bodyRef,
  value,
  placeholder,
  busy,
  draft,
  onChange,
}: {
  bodyRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  placeholder: string;
  busy: boolean;
  draft: Draft;
  onChange: (v: string) => void;
}): React.ReactElement {
  const empty = !value.trim();
  const reply = draft.mode === "reply" || draft.mode === "replyAll";
  const [idx, setIdx] = useState(0);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const threadGmailId = draft.thread_gmail_id;
  const accountId = draft.account_id;

  useEffect(() => {
    if (!empty || busy || !reply || !threadGmailId) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void loadSuggestions(threadGmailId, accountId).then((list) => {
        if (!cancelled) {
          setSuggestions(list);
          setIdx(0);
        }
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [empty, busy, reply, threadGmailId, accountId]);

  const list = empty && !busy ? suggestions : [];
  const ghost = list.length > 0 ? list[((idx % list.length) + list.length) % list.length] : null;

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = "auto";
    const ghostEl = el.parentElement?.querySelector(".compose-ghost") as HTMLElement | null;
    el.style.height = `${Math.max(el.scrollHeight, ghostEl?.scrollHeight ?? 0)}px`;
  }, [value, ghost, bodyRef]);

  const accept = () => {
    if (!ghost) return;
    onChange(ghost);
    requestAnimationFrame(() => {
      const pos = ghost.length;
      bodyRef.current?.setSelectionRange(pos, pos);
    });
  };
  const cycle = (delta: 1 | -1) => {
    if (list.length < 2) return;
    setIdx((i) => i + delta);
  };

  return (
    <div className={`compose-body-wrap${busy ? " is-busy" : ""}`}>
      {ghost && (
        <>
          <div className="compose-ghost" aria-hidden>
            {ghost}
          </div>
          <span className="compose-ghost-cap">
            {list.length > 1 && (
              <span className="compose-ghost-n">
                {((idx % list.length) + list.length) % list.length + 1}/{list.length}
              </span>
            )}
            <button
              type="button"
              className="compose-ghost-tab"
              tabIndex={-1}
              title="Insert this suggestion"
              onMouseDown={(e) => e.preventDefault()}
              onClick={accept}
            >
              <KeyCap spec="tab" />
            </button>
          </span>
        </>
      )}
      <textarea
        ref={bodyRef}
        className="compose-body"
        value={value}
        placeholder={busy || ghost ? "" : placeholder}
        readOnly={busy}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          const action = ghostKeyAction({
            empty,
            count: list.length,
            key: e.key,
            shift: e.shiftKey,
          });
          if (!action) return;
          e.preventDefault();
          if (action === "accept") accept();
          else cycle(action === "next" ? 1 : -1);
        }}
      />
      {busy && (
        <span className="compose-busy" aria-live="polite">
          <span className="compose-busy-dot" />
          whisk is writing…
        </span>
      )}
    </div>
  );
}

/** A reply belongs inside its thread: when the open thread is the one the
 *  draft replies into, the composer renders inline under the messages instead
 *  of floating. Forwards and fresh mail keep the floating panel. */
export function composeIsInline(s: {
  composeDraftId: string | null;
  drafts: Record<string, Pick<Draft, "mode" | "thread_gmail_id">>;
  openThreadId: string | null;
  threads: Record<string, { gmail_id: string }>;
}): boolean {
  const draft = s.composeDraftId ? s.drafts[s.composeDraftId] : null;
  const open = s.openThreadId ? s.threads[s.openThreadId] : null;
  return !!draft && !!open && draftsIn(draft, open.gmail_id);
}

export function Compose({ inline }: { inline?: boolean } = {}): React.ReactElement | null {
  const s = useTracked([
    (s) => s.composeDraftId,
    (s) => s.composeMinimized,
    (s) => (s.composeDraftId ? s.drafts[s.composeDraftId] : null),
    (s) => composeIsInline(s),
    (s) => s.composeAiBusy,
    (s) => s.composeHeadOpen,
  ]);
  const draft = s.composeDraftId ? s.drafts[s.composeDraftId] : null;
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Replies land in the body; fresh composes land in To (autoFocus there),
    // and so does a forward with nobody to send it to yet.
    const needsTo = !!draft && draft.mode !== "new" && draft.to.length === 0;
    if (draft && draft.mode !== "new" && !needsTo) bodyRef.current?.focus();
    useMailStore.getState().setComposeHeadOpen(needsTo);
  }, [s.composeDraftId]);

  const headWasOpen = useRef(false);
  useEffect(() => {
    // In the floating panel the fields are already on screen: ⌘E is "go to
    // To" there, and the flag is consumed at once.
    if (s.composeHeadOpen && !inline && toRef.current) {
      toRef.current.focus();
      useMailStore.getState().setComposeHeadOpen(false);
    }
    // Closing the inline popover hands the keyboard back to the body.
    if (inline && headWasOpen.current && !s.composeHeadOpen) bodyRef.current?.focus();
    headWasOpen.current = s.composeHeadOpen;
  }, [s.composeHeadOpen]);

  if (!draft) return null;
  const inlineActive = composeIsInline(useMailStore.getState());
  // Exactly one composer renders: the inline one inside ThreadView when the
  // reply belongs there, the floating panel otherwise. The minimized pill is
  // always the floating instance's.
  if (!inline && inlineActive && !s.composeMinimized) return null;
  if (inline && (!inlineActive || s.composeMinimized)) return null;
  const st = useMailStore.getState();

  if (inline) {
    // Which address the reply leaves from, named whenever there was a choice.
    const account = draft.account_id ? st.accounts[draft.account_id] : undefined;
    const inlineFrom =
      account && (Object.keys(st.accounts).length > 1 || sendAddresses(account).length > 1)
        ? fromAddress(account, draft.from).email
        : null;
    return (
      <section className="compose compose-inline" aria-label={composeLabels(draft.mode).title} onPaste={handleComposePaste}>
        <div className="compose-inline-to">
          <button
            className="compose-inline-summary"
            tabIndex={-1}
            title="Edit recipients and subject (⌘E)"
            onClick={() => st.setComposeHeadOpen(!s.composeHeadOpen)}
          >
            <span className="compose-inline-verb">
              {composeLabels(draft.mode).verb}
            </span>
            <span className="compose-inline-names">
              {draft.to.map((a) => a.name ?? a.email).join(", ") || "…"}
              {draft.cc.length > 0 && (
                <span className="compose-inline-extra"> · cc {draft.cc.map((a) => a.name ?? a.email).join(", ")}</span>
              )}
              {draft.bcc.length > 0 && (
                <span className="compose-inline-extra"> · bcc {draft.bcc.map((a) => a.name ?? a.email).join(", ")}</span>
              )}
            </span>
            {inlineFrom && <span className="compose-inline-from">from {inlineFrom}</span>}
            <span className="compose-inline-edit">
              edit <KeyCap spec="mod+e" />
            </span>
          </button>
          <span className="compose-head-actions">
            <button tabIndex={-1} title="Discard" onClick={() => st.discardCompose()}>
              ×
            </button>
          </span>
          {s.composeHeadOpen && <HeadPopover draft={draft} />}
        </div>
        <ComposeBody
          bodyRef={bodyRef}
          value={draft.body_text}
          placeholder={draft.mode === "forward" ? "Add a note…" : "Write your reply…"}
          busy={s.composeAiBusy}
          draft={draft}
          onChange={(body_text) => st.updateComposeDraft({ body_text })}
        />
        <ComposeFiles draft={draft} />
        <ComposeFoot />
      </section>
    );
  }

  if (s.composeMinimized) {
    return (
      <button className="compose-pill" onClick={() => st.minimizeCompose(false)}>
        <span className="compose-pill-dot" />
        {/* The title truncates, not the pill: a long subject must not push the
            dot out of the flex row. */}
        <span className="compose-pill-title">{draft.subject || "Draft"}</span>
      </button>
    );
  }

  return (
    <section className="compose" aria-label="Compose" onPaste={handleComposePaste}>
      <header className="compose-head">
        <span className="compose-title">{composeLabels(draft.mode).title}</span>
        <span className="compose-head-actions">
          <button tabIndex={-1} title="Minimize (esc)" onClick={() => st.minimizeCompose(true)}>
            —
          </button>
          <button tabIndex={-1} title="Discard" onClick={() => st.discardCompose()}>
            ×
          </button>
        </span>
      </header>

      <HeaderFields draft={draft} autoFocusTo={draft.mode === "new"} toRef={toRef} />
      <ComposeBody
        bodyRef={bodyRef}
        value={draft.body_text}
        placeholder="Write…"
        busy={s.composeAiBusy}
        draft={draft}
        onChange={(body_text) => st.updateComposeDraft({ body_text })}
      />
      <ComposeFiles draft={draft} />
      <ComposeFoot />
    </section>
  );
}
