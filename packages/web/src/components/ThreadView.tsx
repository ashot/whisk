import { LensChips } from "./Lenses";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { msgExpandedDefault, shownTopic, threadDrafts } from "../store/selectors";
import type { Address, Draft, Message } from "../store/types";
import { displayName, fullDate, initials, recipientsLine, relativeDate, senderHue } from "../lib/format";
import { isOwnAddress, type Sender } from "@mail/shared/src/lib/sendAs";
import { preloadAttachments } from "../lib/attachmentFiles";
import { AttachmentChips } from "./Attachments";
import { HtmlBody } from "./HtmlBody";
import { QuotedFold } from "./QuotedFold";
import { splitQuotedText } from "@mail/shared/src/lib/quotes";
import { Compose, composeIsInline } from "./Compose";
import { HintPair } from "./KeyCap";
import { ThreadActions } from "./MobileNav";
import { PrivacyChip } from "./PrivacyChip";

function MessageDetails({ m }: { m: Message }): React.ReactElement {
  const row = (label: string, people: Address[]) => {
    if (people.length === 0) return null;
    return (
      <div className="msg-detail-row">
        <span className="msg-detail-label">{label}</span>
        <span className="msg-detail-value">
          {people.map((a, i) => (
            <span key={`${a.email}-${i}`}>
              {i > 0 ? ", " : ""}
              {a.name ? <span className="msg-detail-name">{a.name} </span> : null}
              <a className="msg-detail-email" href={`mailto:${a.email}`}>
                {a.name ? `<${a.email}>` : a.email}
              </a>
            </span>
          ))}
        </span>
      </div>
    );
  };
  return (
    <div className="msg-details">
      {row("From", [m.from])}
      {row("To", m.to)}
      {row("Cc", m.cc ?? [])}
      {row("Bcc", m.bcc ?? [])}
      {m.reply_to ? row("Reply-To", [m.reply_to]) : null}
      <div className="msg-detail-row">
        <span className="msg-detail-label">Date</span>
        <span className="msg-detail-value">{fullDate(m.date)}</span>
      </div>
    </div>
  );
}

/** A plain-text body, its quoted trail folded like an HTML one. */
function TextBody({ text }: { text: string }): React.ReactElement {
  const split = useMemo(() => splitQuotedText(text), [text]);
  if (!split) return <pre className="msg-text">{text}</pre>;
  return (
    <>
      <pre className="msg-text">{split.fresh}</pre>
      <QuotedFold attribution={split.attribution} count={split.count}>
        {() => <pre className="msg-text is-quoted">{split.quoted}</pre>}
      </QuotedFold>
    </>
  );
}

function MessageCard({
  m,
  me,
  expanded,
  focused,
  mine,
}: {
  m: Message;
  me?: Sender;
  expanded: boolean;
  focused: boolean;
  mine: boolean;
}): React.ReactElement {
  const st = useMailStore.getState();
  const ref = useRef<HTMLDivElement>(null);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  const toLine = recipientsLine(m, me);

  if (!expanded) {
    return (
      <div ref={ref} className={`msg is-collapsed${focused ? " is-focused" : ""}`}>
        <button className="msg-collapsed" onClick={() => st.toggleMsgExpanded(m.gmail_id)}>
          <span className="msg-avatar" style={{ ["--hue" as any]: senderHue(m.from.email) }}>
            {initials(m.from)}
          </span>
          <span className="msg-collapsed-from">{displayName(m.from, me)}</span>
          <span className="msg-collapsed-snippet">{m.snippet}</span>
          <span className="msg-collapsed-date">{relativeDate(m.date)}</span>
        </button>
      </div>
    );
  }

  return (
    <article ref={ref} className={`msg${focused ? " is-focused" : ""}${mine ? " is-mine" : ""}`}>
      <header
        className="msg-head"
        onClick={() => st.toggleMsgExpanded(m.gmail_id)}
        title="Collapse (o)"
      >
        <span className="msg-avatar" style={{ ["--hue" as any]: senderHue(m.from.email) }}>
          {initials(m.from)}
        </span>
        <div className="msg-who">
          <span className="msg-from-name" title={m.from.email}>
            {displayName(m.from, me)}
          </span>
          {toLine && (
            <button
              type="button"
              className={`msg-to-inline${details ? " is-open" : ""}`}
              aria-expanded={details}
              title={details ? "Hide full addresses" : "Show full addresses"}
              onClick={(e) => {
                e.stopPropagation();
                setDetails((open) => !open);
              }}
            >
              {toLine}
            </button>
          )}
        </div>
        <time className="msg-date" title={fullDate(m.date)}>
          {relativeDate(m.date)}
        </time>
      </header>
      {details && <MessageDetails m={m} />}
      <div className="msg-body">
        {m.body_html ? (
          <HtmlBody html={m.body_html} messageGmailId={m.gmail_id} />
        ) : (
          <TextBody text={m.body_text ?? m.snippet} />
        )}
      </div>
      <AttachmentChips m={m} />
    </article>
  );
}

/** A reply in progress, sitting where it will land once sent. It reads as
 *  the composer at rest; a click (or r) wakes the composer in its place. */
function DraftCard({ d, me }: { d: Draft; me?: Sender }): React.ReactElement {
  const toLine = recipientsLine(d, me);
  return (
    <button
      type="button"
      className="draft-card"
      title="Keep writing (r)"
      onClick={() => useMailStore.getState().openDraft(d.client_id)}
    >
      <span className="draft-card-head">
        <span className="draft-card-tag">Draft</span>
        {toLine && <span className="draft-card-to">{toLine}</span>}
        <time className="msg-date" title={fullDate(d.updated_at)}>
          {relativeDate(d.updated_at)}
        </time>
      </span>
      {d.body_text.trim() ? (
        <span className="draft-card-body">{d.body_text}</span>
      ) : (
        <span className="draft-card-body is-empty">Nothing written yet</span>
      )}
    </button>
  );
}

/** The catch-up card: what the thread says, without reading it. */
function SummaryCard({
  state,
}: {
  state: { status: "loading" | "done" | "error"; text?: string };
}): React.ReactElement {
  return (
    <aside className={`summary${state.status === "loading" ? " is-loading" : ""}`}>
      <span className="summary-rule" aria-hidden />
      {state.status === "loading" ? (
        <span className="summary-loading">
          <span className="summary-bar" />
          <span className="summary-bar" style={{ width: "82%" }} />
        </span>
      ) : (
        <p className="summary-text">{state.text}</p>
      )}
      <span className="summary-sig">whisk · t to dismiss</span>
    </aside>
  );
}

export function ThreadView(): React.ReactElement | null {
  const s = useTracked([
    (s) => s.openThreadId,
    (s) => (s.openThreadId ? s.threads[s.openThreadId] : null),
    (s) => {
      const t = s.openThreadId ? s.threads[s.openThreadId] : null;
      return t ? s.threadMessages[t.gmail_id] : null;
    },
    (s) => {
      const t = s.openThreadId ? s.threads[s.openThreadId] : null;
      return t ? s.accounts[t.account_id]?.email : undefined;
    },
    (s) => {
      const t = s.openThreadId ? s.threads[s.openThreadId] : null;
      return shownTopic(t?.cluster_id ? s.clusters[t.cluster_id] : undefined, s.clusters);
    },
    (s) => s.msgExpanded,
    (s) => s.msgFocusId,
    (s) => composeIsInline(s) && !s.composeMinimized,
    (s) => {
      const t = s.openThreadId ? s.threads[s.openThreadId] : null;
      return t ? s.threadSummaries[t.gmail_id] : undefined;
    },
    (s) => s.drafts,
  ]);
  const t = s.openThreadId ? s.threads[s.openThreadId] : null;
  // "me" is the account this thread lives in, not a global identity.
  const me = t ? useMailStore.getState().accounts[t.account_id] : undefined;
  const inlineReply = t ? composeIsInline(useMailStore.getState()) : false;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A reply opening inline should be seen, not discovered by scrolling.
    if (inlineReply) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [inlineReply]);
  const messages = t ? (s.threadMessages[t.gmail_id] ?? []) : [];
  useEffect(() => {
    // Files come down as the conversation opens, so a click shows one at
    // once and Finder already has it.
    if (t) preloadAttachments(messages);
  }, [messages]);
  if (!t) return null;
  const topic = shownTopic(t.cluster_id ? s.clusters[t.cluster_id] : undefined, s.clusters);
  const summary = useMailStore.getState().threadSummaries[t.gmail_id];

  return (
    <div className="thread">
      <header className="thread-head">
        <button
          className="thread-back"
          onClick={() => useMailStore.getState().closeThread()}
          title="Back to list (esc)"
          tabIndex={-1}
        >
          ←
        </button>
        <h1 className="thread-subject">{t.subject || "(no subject)"}</h1>
        {topic && (
          <button
            className="row-chip row-topic"
            style={{ ["--hue" as any]: topic.hue }}
            title={`${topic.description || topic.name}. Click to open the topic; T to move this conversation.`}
            tabIndex={-1}
            onClick={() => useMailStore.getState().setView(`cluster:${topic._id}`)}
          >
            {topic.name}
          </button>
        )}
        <LensChips thread={t} />
        <PrivacyChip thread={t} />
        {t.is_starred && <span className="thread-star">★</span>}
        {messages.length > 1 && (
          <span className="thread-msgcount">{messages.length}</span>
        )}
        <ThreadActions starred={t.is_starred} />
      </header>
      <div className="thread-scroll">
        <div className="thread-messages">
          {summary && <SummaryCard state={summary} />}
          {messages.length === 0 ? (
            <div className="thread-loading">
              <span className="thread-loading-bar" />
              <span className="thread-loading-bar" style={{ width: "72%" }} />
              <span className="thread-loading-bar" style={{ width: "84%" }} />
            </div>
          ) : (
            messages.map((m, i) => (
              <MessageCard
                // gmail_id survives the server echo (the optimistic row already
                // carries the id the server will confirm); _id is rekeyed, and
                // keying on it remounts the card and drops its expand state.
                key={m.gmail_id ?? m._id}
                m={m}
                me={me}
                expanded={
                  s.msgExpanded[m.gmail_id] ??
                  msgExpandedDefault(m, i, messages.length)
                }
                focused={s.msgFocusId === m.gmail_id}
                mine={!!me && isOwnAddress(me, m.from.email)}
              />
            ))
          )}
          {threadDrafts(s.drafts, t.gmail_id)
            // The one open in the inline composer renders as the composer.
            .filter((d) => {
              const st = useMailStore.getState();
              return !(inlineReply && !st.composeMinimized && d.client_id === st.composeDraftId);
            })
            .map((d) => (
              <DraftCard key={d.client_id} d={d} me={me} />
            ))}
          {inlineReply ? (
            <Compose inline />
          ) : (
            <div className="thread-replybar">
              <span className="thread-replybar-hint">
                <HintPair clickable spec="r">reply</HintPair>
                <HintPair clickable spec="R">draft for me</HintPair>
                <HintPair clickable spec="a">reply all</HintPair>
                <HintPair clickable spec="f">forward</HintPair>
                {messages.length > 2 && <HintPair clickable spec="t">summarize</HintPair>}
                {messages.length > 1 && <HintPair clickable spec="n">next message</HintPair>}
                {messages.some((m) => m.attachments.length > 0) && <HintPair clickable spec="A">files</HintPair>}
              </span>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}
