import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { openThreadScreen } from "../lib/openThread";
import type { Thread } from "@mail/shared/src/store/types";
import { useCoarseNow } from "@mail/platform";
import { chipsFor, primaryAccount, visibleThreadsFor } from "../lib/account";
import { fonts } from "../lib/theme";
import { useTheme } from "../lib/useTheme";
import { ThreadRow } from "../components/ThreadRow";

// Two-speed search, same grammar as the web app: typing filters the local
// index instantly; submit commits the query and layers Gmail's own results on
// top (spinner while in flight).

export default function SearchScreen(): React.ReactElement {
  const { t } = useTheme();
  const s = (mailStore as any)((x: any) => x) as any;
  const now = useCoarseNow(30_000);
  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState<string>(() =>
    s.activeView.startsWith("search:") ? s.activeView.slice(7) : "",
  );

  // Leaving the screen clears the committed search view.
  useEffect(() => {
    return () => {
      const st = mailStore.getState();
      if (st.activeView.startsWith("search:")) st.setView(st.lastNonSearchView);
      st.setSearch(false);
    };
  }, []);

  const live = query.trim();
  const threads = useMemo(
    () => (live ? (visibleThreadsFor(s, `search:${live}`) as Thread[]) : []),
    [s.threads, live, s.searchHits, s.accountScope, s.labels],
  );
  const me = primaryAccount(s) ?? undefined;
  const searching = s.searchStatus === "searching";
  const st = () => mailStore.getState();

  const commit = () => {
    if (!live) return;
    st().setSearch(true, live);
    st().commitSearch();
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: t.bg }]} edges={["top"]}>
      <View style={[styles.bar, { borderBottomColor: t.rule }]}>
        <Pressable hitSlop={10} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={23} color={t.inkMuted} />
        </Pressable>
        <View style={[styles.field, { backgroundColor: t.bgRaised, borderColor: t.ruleStrong }]}>
          <Text style={[styles.slash, { color: t.accent }]}>/</Text>
          <TextInput
            ref={inputRef}
            autoFocus
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={commit}
            returnKeyType="search"
            placeholder="Search mail…"
            placeholderTextColor={t.inkFaint}
            style={[styles.input, { color: t.ink }]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searching ? (
            <ActivityIndicator size="small" color={t.accent} />
          ) : query ? (
            <Pressable hitSlop={8} onPress={() => setQuery("")}>
              <Ionicons name="close-circle" size={17} color={t.inkFaint} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {searching && (
        <View style={styles.searchingLine}>
          <Text style={[styles.searchingText, { color: t.inkMuted }]}>
            searching all mail…
          </Text>
        </View>
      )}

      {live === "" ? (
        <View style={styles.hint}>
          <Text style={[styles.hintTitle, { color: t.ink }]}>Search everything.</Text>
          <Text style={[styles.hintSub, { color: t.inkFaint }]}>
            Results appear as you type. Submit to search your whole{"\n"}mailbox on
            Gmail — from:, to:, is:unread, has:attachment work too.
          </Text>
        </View>
      ) : threads.length === 0 && !searching ? (
        <View style={styles.hint}>
          <Text style={[styles.hintTitle, { color: t.ink }]}>No matches.</Text>
          <Text style={[styles.hintSub, { color: t.inkFaint }]}>
            Try fewer words, or submit to search all of Gmail.
          </Text>
        </View>
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(item) => item._id}
          keyboardShouldPersistTaps="handled"
          onEndReached={() => st().loadMoreSearch()}
          onEndReachedThreshold={0.6}
          ListFooterComponent={
            searching && threads.length > 0 ? (
              <ActivityIndicator style={styles.footer} size="small" color={t.accent} />
            ) : null
          }
          renderItem={({ item }) => (
            <ThreadRow
              thread={item}
              me={me}
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingBottom: 10,
    paddingTop: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  field: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
  },
  slash: { fontFamily: fonts.mono, fontSize: 14 },
  input: { flex: 1, fontFamily: fonts.ui, fontSize: 15, paddingVertical: 0 },
  searchingLine: { paddingHorizontal: 18, paddingTop: 10 },
  footer: { paddingVertical: 18 },
  searchingText: { fontFamily: fonts.ui, fontSize: 12.5 },
  hint: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, paddingBottom: 100 },
  hintTitle: { fontFamily: fonts.uiSemiBold, fontSize: 17 },
  hintSub: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 19, textAlign: "center" },
});
