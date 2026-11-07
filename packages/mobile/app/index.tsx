import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@mail/convex/convex/_generated/api";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { openThreadScreen } from "../lib/openThread";
import { inScope, inboxLenses, isInboxList, lensView, viewTitle } from "@mail/shared/src/store/selectors";
import type { Draft, Thread, ViewId } from "@mail/shared/src/store/types";
import { relativeDate } from "@mail/shared/src/lib/format";
import { useCoarseNow } from "@mail/platform";
import { convexClient } from "../lib/convex";
import { allAccounts, chipsFor, primaryAccount, visibleThreadsFor } from "../lib/account";
import { fonts } from "../lib/theme";
import { useTheme } from "../lib/useTheme";
import { AccountButton } from "../components/AccountMenu";
import { ThreadRow } from "../components/ThreadRow";
import { Welcome } from "../components/Welcome";

// The inbox lists (Important, the person's views, Other) lead; the
// mailbox's own places follow.
const PLACES: Array<{ id: ViewId; name: string }> = [
  { id: "starred", name: "Starred" },
  { id: "drafts", name: "Drafts" },
  { id: "sent", name: "Sent" },
  { id: "archive", name: "Archive" },
  { id: "trash", name: "Trash" },
  { id: "spam", name: "Spam" },
];

const EMPTY_LINES: Record<string, [string, string]> = {
  inbox: ["Nothing important.", "The rest is under Other."],
  other: ["Nothing else.", "Everything in the inbox is marked important."],
  lens: ["Nothing in this view.", "Widen it from the inbox on the web."],
  starred: ["No stars.", "Swipe a conversation to keep it close."],
  sent: ["Nothing sent yet.", "Write your first below."],
  archive: ["Archive is empty.", "Swipe right to file things away."],
  trash: ["Trash is empty.", "Nothing rots here."],
  spam: ["No spam.", "The filters are eating well."],
  drafts: ["No drafts.", "Half-written thoughts live here."],
};

function DraftRow({
  draft,
  now,
  onPress,
}: {
  draft: Draft;
  now: number;
  onPress: () => void;
}): React.ReactElement {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.draftRow,
        { borderBottomColor: t.rule, backgroundColor: pressed ? t.bgHover : t.bg },
      ]}
    >
      <Text style={[styles.draftTag, { color: t.danger }]}>Draft</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[styles.draftSubject, { color: t.ink }]}>
          {draft.subject || "(no subject)"}
        </Text>
        <Text numberOfLines={1} style={[styles.draftBody, { color: t.inkFaint }]}>
          {draft.body_text || "Empty draft"}
        </Text>
      </View>
      <Text style={[styles.draftDate, { color: t.inkFaint }]}>
        {relativeDate(draft.updated_at, now)}
      </Text>
    </Pressable>
  );
}

export default function InboxScreen(): React.ReactElement {
  const { t, mode } = useTheme();
  const s = (mailStore as any)((x: any) => x) as any;
  const now = useCoarseNow(30_000);
  const [refreshing, setRefreshing] = useState(false);

  const hasAccount = !!primaryAccount(s);
  const view: ViewId = s.activeView.startsWith("search:") ? "inbox" : s.activeView;
  const threads = useMemo(
    () => (hasAccount ? (visibleThreadsFor(s, view) as Thread[]) : []),
    [s.threads, view, s.accountScope, hasAccount],
  );
  const accounts = allAccounts(s);
  // With one mailbox (or a scoped view) "me" collapses correctly; in the
  // unified view rows resolve "me" per thread via its own account.
  const meFor = (thread: Thread) =>
    s.accounts?.[(thread as any).account_id] ?? primaryAccount(s) ?? undefined;
  const unread = useMemo(
    () => threads.filter((x) => x.is_unread).length,
    [threads],
  );
  const drafts = useMemo(
    () =>
      (Object.values(s.drafts ?? {}) as Draft[])
        .filter((d) => inScope(d, s.accountScope))
        .sort((a, b) => b.updated_at - a.updated_at),
    [s.drafts, s.accountScope],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const token = mailStore.getState().authToken;
      if (token) await convexClient().mutation(api.sync.refresh, { token });
      // Give the incremental sync a beat to land its first rows.
      await new Promise((r) => setTimeout(r, 900));
    } catch {}
    setRefreshing(false);
  }, []);

  // Same rule as the web shell: a token with an empty roster is a cold cache
  // (fresh install, cleared data) with the account envelope inbound, not a
  // signed-out user. Paint quiet until it lands; the splash covers the wait.
  if (!hasAccount) {
    if (!s.hydrated || s.authToken) {
      return (
        <View style={[styles.safe, styles.quiet, { backgroundColor: t.bg }]}>
          <ActivityIndicator color={t.inkFaint} />
        </View>
      );
    }
    return <Welcome />;
  }

  const lenses = inboxLenses(s);
  const views: Array<{ id: ViewId; name: string }> = [
    ...lenses.map((l) => ({ id: lensView(l.id), name: l.name })),
    { id: "other", name: "Other" },
    ...PLACES,
  ];
  const setView = (v: ViewId) => mailStore.getState().setView(v);
  const st = () => mailStore.getState();

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: t.bg }]} edges={["top"]}>
      <View style={styles.header}>
        <Text style={[styles.brand, { color: t.ink }]}>
          {views.find((v) => v.id === view)?.name ?? viewTitle(view)}
          {isInboxList(view) && unread > 0 && (
            <Text style={[styles.unread, { color: t.accent }]}>  {unread}</Text>
          )}
        </Text>
        <View style={styles.headerActions}>
          <Pressable hitSlop={8} onPress={() => router.push("/search")}>
            <Ionicons name="search" size={21} color={t.inkMuted} />
          </Pressable>
          <AccountButton accounts={accounts} scope={s.accountScope} t={t} mode={mode} />
        </View>
      </View>

      <View style={[styles.chipsRow, { borderBottomColor: t.rule }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {views.map((v) => {
            const active = view === v.id;
            return (
              <Pressable
                key={v.id}
                onPress={() => setView(v.id)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: active ? t.accentSoft : "transparent",
                    borderColor: active ? t.accent : t.rule,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    {
                      color: active ? t.accent : t.inkMuted,
                      fontFamily: active ? fonts.uiSemiBold : fonts.uiMedium,
                    },
                  ]}
                >
                  {v.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {view === "drafts" ? (
        drafts.length === 0 ? (
          <EmptyState view="drafts" />
        ) : (
          <FlatList
            data={drafts}
            keyExtractor={(d) => d.client_id}
            renderItem={({ item }) => (
              <DraftRow
                draft={item}
                now={now}
                onPress={() => {
                  st().openDraft(item.client_id);
                  router.push("/compose");
                }}
              />
            )}
          />
        )
      ) : threads.length === 0 ? (
        <EmptyState view={view} />
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(item) => item._id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.inkFaint} />
          }
          initialNumToRender={14}
          maxToRenderPerBatch={16}
          windowSize={9}
          renderItem={({ item }) => (
            <ThreadRow
              thread={item}
              me={meFor(item)}
              chips={chipsFor(s, item)}
              now={now}
              t={t}
              onPress={() => openThreadScreen(item._id)}
              onArchive={() => st().archive([item._id])}
              onTrash={() => st().trash([item._id])}
              onStar={() => st().toggleStar(item._id)}
            />
          )}
        />
      )}

      <Pressable
        onPress={() => {
          st().startCompose("new");
          router.push("/compose");
        }}
        style={({ pressed }) => [
          styles.fab,
          {
            backgroundColor: t.accent,
            transform: [{ scale: pressed ? 0.94 : 1 }],
            shadowColor: t.ink,
          },
        ]}
      >
        <Ionicons name="create-outline" size={24} color={t.accentInk} />
      </Pressable>
    </SafeAreaView>
  );
}

function EmptyState({ view }: { view: string }): React.ReactElement {
  const { t } = useTheme();
  const [title, sub] = EMPTY_LINES[view.startsWith("lens:") ? "lens" : view] ?? ["Nothing here.", ""];
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: t.ink }]}>{title}</Text>
      <Text style={[styles.emptySub, { color: t.inkFaint }]}>{sub}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  quiet: { alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 6,
    paddingBottom: 8,
  },
  brand: { fontFamily: fonts.uiSemiBold, fontSize: 24, letterSpacing: 0.1 },
  unread: { fontFamily: fonts.mono, fontSize: 13 },
  headerActions: { flexDirection: "row", gap: 18, alignItems: "center" },
  chipsRow: { borderBottomWidth: StyleSheet.hairlineWidth },
  chips: { paddingHorizontal: 14, paddingBottom: 10, gap: 7 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 15,
    borderWidth: 1,
  },
  chipText: { fontSize: 12.5 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6, paddingBottom: 80 },
  emptyTitle: { fontFamily: fonts.uiSemiBold, fontSize: 17 },
  emptySub: { fontFamily: fonts.ui, fontSize: 13.5 },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 28,
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 5,
  },
  draftRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  draftTag: { fontFamily: fonts.uiSemiBold, fontSize: 12 },
  draftSubject: { fontFamily: fonts.uiMedium, fontSize: 14 },
  draftBody: { fontFamily: fonts.ui, fontSize: 12.5, marginTop: 1 },
  draftDate: { fontFamily: fonts.mono, fontSize: 11 },
});
