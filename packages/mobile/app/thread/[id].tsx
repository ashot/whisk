import { IMPORTANT, inLens, lensJudged } from "@mail/shared/src/lib/lenses";
import { inboxLenses } from "@mail/shared/src/store/selectors";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { msgExpandedDefault, threadDrafts } from "@mail/shared/src/store/selectors";
import type { Address, Draft, Message, Thread } from "@mail/shared/src/store/types";
import { displayName, recipientsLine } from "@mail/shared/src/lib/format";
import { composeLabels } from "@mail/shared/src/lib/compose";
import type { Sender } from "@mail/shared/src/lib/sendAs";
import { fonts } from "../../lib/theme";
import { useTheme } from "../../lib/useTheme";
import { MessageCard } from "../../components/MessageCard";
import { AddressField } from "../../components/AddressField";

export default function ThreadScreen(): React.ReactElement | null {
  const { t, mode } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const s = (mailStore as any)((x: any) => x) as any;
  const scrollRef = useRef<ScrollView>(null);
  const [replying, setReplying] = useState(false);

  const threadId = s.openThreadId ?? id;
  const thread: Thread | null = threadId ? s.threads[threadId] ?? null : null;
  const messages: Message[] = thread ? s.threadMessages[thread.gmail_id] ?? [] : [];
  // "me" is the account this thread lives in (multi-account safe).
  const me: Sender | undefined = thread ? (s.accounts?.[thread.account_id] ?? s.account ?? undefined) : undefined;

  const draft = s.composeDraftId ? s.drafts[s.composeDraftId] : null;
  const replyDraft =
    draft && draft.thread_gmail_id === thread?.gmail_id ? draft : null;

  // Keep the reply input in view when it opens.
  useEffect(() => {
    if (replying) {
      const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
      return () => clearTimeout(timer);
    }
  }, [replying]);

  const expandedCount = useMemo(
    () =>
      messages.filter(
        (m, i) => s.msgExpanded[m.gmail_id] ?? msgExpandedDefault(m, i, messages.length),
      ).length,
    [messages, s.msgExpanded],
  );

  const st = () => mailStore.getState();

  const back = () => {
    st().closeThread();
    router.back();
  };

  const loading = (
    <View style={styles.loading}>
      {[0.6, 0.72, 0.84].map((w) => (
        <View
          key={w}
          style={[styles.loadingBar, { backgroundColor: t.bgSunken, width: `${w * 100}%` }]}
        />
      ))}
    </View>
  );

  // A tapped push can open a thread a moment before its row is local. Hold
  // the frame, with a way back, until the row lands.
  if (!thread) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: t.bg }]} edges={["top"]}>
        <View style={[styles.header, { borderBottomColor: t.rule }]}>
          <Pressable onPress={back} hitSlop={10} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={23} color={t.inkMuted} />
          </Pressable>
        </View>
        {loading}
      </SafeAreaView>
    );
  }

  // The store picks up a reply or forward already drafted here.
  const startReply = (mode: "reply" | "replyAll" | "forward") => {
    st().startCompose(mode, thread.gmail_id);
    setReplying(true);
  };

  const forwarding = replyDraft?.mode === "forward";
  const canSend = !!replyDraft && replyDraft.to.length > 0 && !!replyDraft.body_text.trim();
  const send = () => {
    if (!canSend) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    st().sendCompose();
    setReplying(false);
  };

  const allOpen = expandedCount === messages.length && messages.length > 0;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: t.bg }]} edges={["top"]}>
      <View style={[styles.header, { borderBottomColor: t.rule }]}>
        <Pressable onPress={back} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={23} color={t.inkMuted} />
        </Pressable>
        <View style={styles.headTitle}>
          <Text numberOfLines={2} style={[styles.subject, { color: t.ink }]}>
            {thread.subject || "(no subject)"}
          </Text>
          {lensJudged(thread, IMPORTANT) && thread.label_ids.includes("INBOX") && (() => {
            const important = inLens(thread, inboxLenses(st())[0]);
            return (
              <Pressable
                hitSlop={6}
                onPress={() => st().markInLens(!important, [thread._id], IMPORTANT)}
                style={styles.importance}
              >
                <Text style={[styles.importanceLabel, { color: important ? t.accent : t.inkMuted }]}>
                  {important ? "Important" : "Other"}
                </Text>
                <Text numberOfLines={1} style={[styles.importanceWhy, { color: t.inkFaint }]}>
                  {thread.lens_marks?.[IMPORTANT] !== undefined ? "placed by you" : thread.lens_why?.[IMPORTANT]}
                </Text>
              </Pressable>
            );
          })()}
        </View>
        {thread.is_starred && (
          <Ionicons name="star" size={15} color={t.star} style={{ marginTop: 3 }} />
        )}
        {messages.length > 1 && (
          <Pressable
            hitSlop={8}
            onPress={() => st().setAllMsgExpanded(!allOpen)}
            style={[styles.countPill, { borderColor: t.rule }]}
          >
            <Text style={[styles.countText, { color: t.inkFaint }]}>
              {messages.length}
            </Text>
            <Ionicons
              name={allOpen ? "chevron-up" : "chevron-down"}
              size={12}
              color={t.inkFaint}
            />
          </Pressable>
        )}
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 12 }}
        >
          {messages.length === 0 ? (
            loading
          ) : (
            messages.map((m, i) => (
              <MessageCard
                key={m.gmail_id ?? m._id}
                m={m}
                me={me}
                expanded={
                  s.msgExpanded[m.gmail_id] ?? msgExpandedDefault(m, i, messages.length)
                }
                mode={mode}
                t={t}
                onToggle={() => st().toggleMsgExpanded(m.gmail_id)}
              />
            ))
          )}

          {/* Replies in progress sit where they will land; a tap picks one up. */}
          {thread &&
            threadDrafts(s.drafts, thread.gmail_id)
              .filter((d: Draft) => !(replying && d.client_id === replyDraft?.client_id))
              .map((d: Draft) => (
                <Pressable
                  key={d.client_id}
                  onPress={() => {
                    st().openDraft(d.client_id);
                    setReplying(true);
                  }}
                  style={[
                    styles.replyBox,
                    styles.draftCard,
                    { borderColor: t.ruleStrong, backgroundColor: t.bgRaised },
                  ]}
                >
                  <Text numberOfLines={1} style={[styles.replyVerb, { color: t.inkFaint }]}>
                    <Text style={{ color: t.accent, fontFamily: fonts.uiSemiBold, fontStyle: "italic" }}>Draft</Text>
                    {recipientsLine(d, me) ? `  ${recipientsLine(d, me)}` : ""}
                  </Text>
                  <Text numberOfLines={8} style={[styles.draftBody, { color: d.body_text.trim() ? t.ink : t.inkFaint }]}>
                    {d.body_text.trim() || "Nothing written yet"}
                  </Text>
                </Pressable>
              ))}

          {replying && replyDraft && (
            <View
              style={[
                styles.replyBox,
                { borderColor: t.ruleStrong, backgroundColor: t.bgRaised },
              ]}
            >
              <View style={styles.replyHead}>
                <Text style={[styles.replyVerb, { color: t.inkFaint }]}>
                  {/* A forward names its recipients in the To field below. */}
                  {forwarding ? composeLabels(replyDraft.mode).title : composeLabels(replyDraft.mode).verb}{" "}
                  {!forwarding && (
                    <Text style={{ color: t.ink, fontFamily: fonts.uiSemiBold }}>
                      {replyDraft.to.map((a: Address) => displayName(a, me)).join(", ")}
                    </Text>
                  )}
                </Text>
                <Pressable
                  hitSlop={8}
                  onPress={() => {
                    st().discardCompose();
                    setReplying(false);
                  }}
                >
                  <Ionicons name="close" size={17} color={t.inkFaint} />
                </Pressable>
              </View>
              {forwarding && (
                <View style={styles.forwardTo}>
                  <AddressField
                    label="To"
                    value={replyDraft.to}
                    autoFocus={replyDraft.to.length === 0}
                    onChange={(to) => st().updateComposeDraft({ to })}
                  />
                </View>
              )}
              <TextInput
                multiline
                autoFocus={replyDraft.to.length > 0}
                value={replyDraft.body_text}
                onChangeText={(body_text) => st().updateComposeDraft({ body_text })}
                placeholder={forwarding ? "Add a note…" : "Write your reply…"}
                placeholderTextColor={t.inkFaint}
                style={[styles.replyInput, { color: t.ink }]}
              />
              <View style={styles.replyFoot}>
                <Text style={[styles.replySaves, { color: t.inkFaint }]}>
                  draft saves as you type
                </Text>
                <Pressable
                  onPress={send}
                  disabled={!canSend}
                  style={[styles.sendBtn, { backgroundColor: canSend ? t.accent : t.bgSunken }]}
                >
                  <Ionicons name="arrow-up" size={17} color={canSend ? t.accentInk : t.inkFaint} />
                </Pressable>
              </View>
            </View>
          )}
        </ScrollView>

        {!replying && (
          <View
            style={[
              styles.replyBar,
              {
                borderTopColor: t.rule,
                backgroundColor: t.bg,
                paddingBottom: Math.max(insets.bottom, 10),
              },
            ]}
          >
            <Pressable
              onPress={() => startReply("reply")}
              style={({ pressed }) => [
                styles.replyPill,
                { borderColor: t.ruleStrong, backgroundColor: pressed ? t.bgHover : t.bgRaised },
              ]}
            >
              <Ionicons name="arrow-undo-outline" size={15} color={t.inkMuted} />
              <Text style={[styles.replyPillText, { color: t.inkMuted }]}>Reply</Text>
            </Pressable>
            <Pressable
              onPress={() => startReply("replyAll")}
              hitSlop={6}
              style={[styles.replyAll, { borderColor: t.ruleStrong }]}
            >
              <Ionicons name="people-outline" size={16} color={t.inkMuted} />
            </Pressable>
            <Pressable
              onPress={() => startReply("forward")}
              hitSlop={6}
              style={[styles.replyAll, { borderColor: t.ruleStrong }]}
            >
              <Ionicons name="arrow-redo-outline" size={16} color={t.inkMuted} />
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 10,
    paddingBottom: 12,
    paddingTop: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { paddingTop: 2 },
  headTitle: { flex: 1, minWidth: 0 },
  subject: { fontFamily: fonts.readSemiBold, fontSize: 19, lineHeight: 24 },
  importance: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 4 },
  importanceLabel: { fontFamily: fonts.uiMedium, fontSize: 12 },
  importanceWhy: { fontFamily: fonts.ui, fontSize: 12, flexShrink: 1 },
  countPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    borderWidth: 1,
    borderRadius: 11,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginTop: 1,
  },
  countText: { fontFamily: fonts.mono, fontSize: 11 },
  loading: { padding: 22, gap: 10 },
  loadingBar: { height: 12, borderRadius: 4 },
  replyBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  replyPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 16,
  },
  replyPillText: { fontFamily: fonts.uiMedium, fontSize: 14 },
  replyAll: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  replyBox: {
    marginHorizontal: 14,
    marginTop: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  draftCard: { borderStyle: "dashed" },
  draftBody: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, paddingTop: 8 },
  // The To field runs edge to edge of the reply box.
  forwardTo: { marginHorizontal: -12, marginTop: 6 },
  replyHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  replyVerb: { fontFamily: fonts.ui, fontSize: 12.5, flex: 1 },
  replyInput: {
    fontFamily: fonts.ui,
    fontSize: 15,
    lineHeight: 22,
    minHeight: 90,
    maxHeight: 220,
    textAlignVertical: "top",
    paddingTop: 10,
  },
  replyFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  replySaves: { fontFamily: fonts.ui, fontSize: 11.5 },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
});
