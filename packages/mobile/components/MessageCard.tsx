import React, { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Attachment, Message } from "@mail/shared/src/store/types";
import { addressRows, displayName, formatSize, fullDate, recipientsLine, relativeDate } from "@mail/shared/src/lib/format";
import { headersText, useMessageHeaders } from "@mail/shared/src/store/headersBridge";
import { isOwnAddress, type Sender } from "@mail/shared/src/lib/sendAs";
import { attachmentUrl } from "../lib/attachments";
import { fonts, type Theme } from "../lib/theme";
import { Avatar } from "./Avatar";
import { HtmlBody } from "./HtmlBody";

// One message in the conversation — same chat-like grammar as the web thread
// view: a single header line, serif body on the page (no card chrome), your
// own messages marked by an accented avatar ring.

function AttachmentChips({
  m,
  t,
}: {
  m: Message;
  t: Theme;
}): React.ReactElement | null {
  if (m.attachments.length === 0) return null;
  return (
    <View style={styles.attachments}>
      {m.attachments.map((a: Attachment, i: number) => {
        const href = attachmentUrl(m.gmail_id, a);
        return (
          <Pressable
            key={i}
            disabled={!href}
            onPress={() => href && void Linking.openURL(href).catch(() => {})}
            style={[styles.chip, { borderColor: t.rule, backgroundColor: t.bgRaised }]}
          >
            <Ionicons name="document-outline" size={13} color={t.inkMuted} />
            <Text numberOfLines={1} style={[styles.chipName, { color: t.ink }]}>
              {a.filename}
            </Text>
            <Text style={[styles.chipSize, { color: t.inkFaint }]}>
              {formatSize(a.size)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Every address on the message, its full date, and on request the whole
 *  header block from Gmail. */
function MessageDetails({ m, t }: { m: Message; t: Theme }): React.ReactElement {
  const [headers, toggleHeaders] = useMessageHeaders(m.gmail_id);
  const row = (label: string, value: string) => (
    <View key={label} style={styles.detailRow}>
      <Text style={[styles.detailLabel, { color: t.inkFaint }]}>{label}</Text>
      <Text selectable style={[styles.detailValue, { color: t.ink }]}>
        {value}
      </Text>
    </View>
  );
  return (
    <View style={[styles.details, { borderColor: t.rule, backgroundColor: t.bgSunken }]}>
      {addressRows(m).map(({ label, people }) =>
        row(label, people.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ")),
      )}
      {row("Date", fullDate(m.date))}
      <Pressable onPress={toggleHeaders} hitSlop={8} style={styles.headersToggle}>
        <Text style={[styles.headersToggleText, { color: t.inkMuted }]}>
          {headers.status === "open"
            ? "Hide all headers"
            : headers.status === "loading"
              ? "Loading headers…"
              : headers.status === "error"
                ? "Couldn't load headers, tap to retry"
                : "All headers"}
        </Text>
      </Pressable>
      {headers.status === "open" && (
        <Text selectable style={[styles.headers, { color: t.inkMuted }]}>
          {headersText(headers.headers)}
        </Text>
      )}
    </View>
  );
}

export function MessageCard({
  m,
  me,
  expanded,
  mode,
  t,
  onToggle,
}: {
  m: Message;
  me?: Sender;
  expanded: boolean;
  mode: "light" | "dark";
  t: Theme;
  onToggle: () => void;
}): React.ReactElement {
  const mine = !!me && isOwnAddress(me, m.from.email);
  const [details, setDetails] = useState(false);

  if (!expanded) {
    return (
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => [
          styles.collapsed,
          { borderTopColor: t.rule, backgroundColor: pressed ? t.bgHover : "transparent" },
        ]}
      >
        <Avatar address={m.from} size={28} theme={t} mode={mode} accented={mine} />
        <Text style={[styles.collapsedFrom, { color: t.ink }]} numberOfLines={1}>
          {displayName(m.from, me)}
        </Text>
        <Text style={[styles.collapsedSnippet, { color: t.inkFaint }]} numberOfLines={1}>
          {m.snippet}
        </Text>
        <Text style={[styles.date, { color: t.inkFaint }]}>{relativeDate(m.date)}</Text>
      </Pressable>
    );
  }

  const toLine = recipientsLine(m, me);

  return (
    <View style={[styles.message, { borderTopColor: t.rule }]}>
      <Pressable onPress={onToggle} style={styles.head}>
        <Avatar address={m.from} size={34} theme={t} mode={mode} accented={mine} />
        <View style={styles.who}>
          <Text style={[styles.fromName, { color: t.ink }]} numberOfLines={1}>
            {displayName(m.from, me)}
          </Text>
          <Pressable onPress={() => setDetails((open) => !open)} hitSlop={6} style={styles.toRow}>
            <Text style={[styles.toLine, { color: details ? t.inkMuted : t.inkFaint }]} numberOfLines={1}>
              {toLine ?? "to undisclosed recipients"}
            </Text>
            <Ionicons name={details ? "chevron-up" : "chevron-down"} size={11} color={t.inkFaint} />
          </Pressable>
        </View>
        <Text style={[styles.date, { color: t.inkFaint }]} accessibilityHint={fullDate(m.date)}>
          {relativeDate(m.date)}
        </Text>
      </Pressable>
      {details && <MessageDetails m={m} t={t} />}
      <View style={styles.body}>
        {m.body_html ? (
          <HtmlBody html={m.body_html} t={t} mode={mode} />
        ) : (
          <Text style={[styles.text, { color: t.ink }]} selectable>
            {m.body_text ?? m.snippet}
          </Text>
        )}
      </View>
      <AttachmentChips m={m} t={t} />
    </View>
  );
}

const styles = StyleSheet.create({
  collapsed: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  collapsedFrom: { fontFamily: fonts.uiSemiBold, fontSize: 13.5, maxWidth: 130 },
  collapsedSnippet: { flex: 1, fontFamily: fonts.ui, fontSize: 13 },
  message: {
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingTop: 14,
  },
  who: { flex: 1, minWidth: 0 },
  fromName: { fontFamily: fonts.uiSemiBold, fontSize: 14.5 },
  toRow: { flexDirection: "row", alignItems: "center", gap: 3, alignSelf: "flex-start", maxWidth: "100%" },
  toLine: { fontFamily: fonts.ui, fontSize: 12, marginTop: 0.5, flexShrink: 1 },
  details: {
    marginTop: 8,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    gap: 5,
  },
  detailRow: { flexDirection: "row", gap: 10 },
  detailLabel: { fontFamily: fonts.mono, fontSize: 10, width: 62, paddingTop: 2, textTransform: "uppercase" },
  detailValue: { fontFamily: fonts.ui, fontSize: 12.5, lineHeight: 17, flex: 1 },
  headersToggle: { paddingLeft: 72, paddingTop: 2 },
  headersToggleText: { fontFamily: fonts.ui, fontSize: 12.5 },
  headers: { fontFamily: fonts.mono, fontSize: 10.5, lineHeight: 15, paddingTop: 4 },
  date: { fontFamily: fonts.mono, fontSize: 11 },
  body: { paddingTop: 8, paddingBottom: 14 },
  text: { fontFamily: fonts.read, fontSize: 16.5, lineHeight: 25 },
  attachments: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingBottom: 16,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 240,
  },
  chipName: { fontFamily: fonts.ui, fontSize: 12.5, flexShrink: 1 },
  chipSize: { fontFamily: fonts.mono, fontSize: 10.5 },
});
