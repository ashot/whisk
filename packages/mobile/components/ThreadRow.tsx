import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Reanimated, {
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import type { Label, Thread } from "@mail/shared/src/store/types";
import { participantsLine, relativeDate } from "@mail/shared/src/lib/format";
import type { Sender } from "@mail/shared/src/lib/sendAs";
import { fonts, type Theme } from "../lib/theme";

// One conversation row. Swipe right → archive (the calm, frequent gesture);
// swipe left reveals trash + star. Unread carries the weight: ink text, a
// vermilion dot, semibold names — read mail recedes to muted.

const ACTION_W = 88;

function RightActions({
  progress,
  onTrash,
  onStar,
  starred,
  t,
}: {
  progress: SharedValue<number>;
  onTrash: () => void;
  onStar: () => void;
  starred: boolean;
  t: Theme;
}): React.ReactElement {
  const style = useAnimatedStyle(() => ({ opacity: progress.value }));
  return (
    <Reanimated.View style={[styles.actions, style]}>
      <Pressable
        style={[styles.action, { backgroundColor: t.star }]}
        onPress={onStar}
      >
        <Ionicons name={starred ? "star" : "star-outline"} size={20} color={t.bgRaised} />
        <Text style={[styles.actionLabel, { color: t.bgRaised }]}>
          {starred ? "Unstar" : "Star"}
        </Text>
      </Pressable>
      <Pressable
        style={[styles.action, { backgroundColor: t.danger }]}
        onPress={onTrash}
      >
        <Ionicons name="trash-outline" size={20} color={t.bgRaised} />
        <Text style={[styles.actionLabel, { color: t.bgRaised }]}>Trash</Text>
      </Pressable>
    </Reanimated.View>
  );
}

function LeftAction({
  progress,
  t,
}: {
  progress: SharedValue<number>;
  t: Theme;
}): React.ReactElement {
  const style = useAnimatedStyle(() => ({ opacity: Math.min(progress.value * 2, 1) }));
  return (
    <Reanimated.View style={[styles.leftAction, { backgroundColor: t.accent }]}>
      <Reanimated.View style={style}>
        <Ionicons name="archive-outline" size={22} color={t.accentInk} />
      </Reanimated.View>
    </Reanimated.View>
  );
}

export const ThreadRow = React.memo(function ThreadRow({
  thread,
  me,
  chips,
  now,
  t,
  onPress,
  onArchive,
  onTrash,
  onStar,
}: {
  thread: Thread;
  me?: Sender;
  chips: Label[];
  now: number;
  t: Theme;
  onPress: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onStar: () => void;
}): React.ReactElement {
  const ref = React.useRef<SwipeableMethods>(null);
  const unread = thread.is_unread;

  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={1.6}
      overshootFriction={8}
      leftThreshold={72}
      rightThreshold={44}
      renderLeftActions={(progress) => <LeftAction progress={progress} t={t} />}
      renderRightActions={(progress) => (
        <RightActions
          progress={progress}
          starred={thread.is_starred}
          t={t}
          onStar={() => {
            ref.current?.close();
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onStar();
          }}
          onTrash={() => {
            ref.current?.close();
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onTrash();
          }}
        />
      )}
      onSwipeableWillOpen={(direction) => {
        // `direction` is the direction of the SWIPE GESTURE (verified on
        // device), not the side of the revealed panel: a left-to-right swipe
        // reports "right" and shows the archive panel — commit it, Gmail
        // style. A right-to-left swipe ("left") reveals the star/trash
        // buttons and waits.
        if (direction === "right") {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onArchive();
          ref.current?.close();
        }
      }}
    >
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.row,
          { backgroundColor: pressed ? t.bgHover : t.bg, borderBottomColor: t.rule },
        ]}
      >
        <View style={styles.dotCol}>
          {unread && <View style={[styles.dot, { backgroundColor: t.accent }]} />}
        </View>
        <View style={styles.body}>
          <View style={styles.topLine}>
            <Text
              numberOfLines={1}
              style={[
                styles.from,
                { color: unread ? t.ink : t.inkMuted },
                unread && { fontFamily: fonts.uiSemiBold },
              ]}
            >
              {participantsLine(thread, me)}
            </Text>
            {thread.is_starred && (
              <Ionicons name="star" size={12} color={t.star} style={styles.starIcon} />
            )}
            <Text style={[styles.date, { color: t.inkFaint }]}>
              {relativeDate(thread.last_at, now)}
            </Text>
          </View>
          <Text numberOfLines={1} style={styles.subjectLine}>
            <Text
              style={[
                styles.subject,
                { color: unread ? t.ink : t.inkMuted },
                unread && { fontFamily: fonts.uiSemiBold },
              ]}
            >
              {thread.subject || "(no subject)"}
            </Text>
          </Text>
          <View style={styles.snippetLine}>
            <Text numberOfLines={1} style={[styles.snippet, { color: t.inkFaint }]}>
              {thread.snippet}
            </Text>
            {thread.has_attachments && (
              <Ionicons name="attach" size={13} color={t.inkFaint} />
            )}
            {chips.slice(0, 2).map((l) => (
              <View
                key={l._id}
                style={[
                  styles.chip,
                  { backgroundColor: l.color?.bg ?? t.bgSunken },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.chipText, { color: l.color?.fg ?? t.inkMuted }]}
                >
                  {l.name}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </Pressable>
    </ReanimatedSwipeable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    paddingVertical: 11,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dotCol: { width: 26, alignItems: "center", paddingTop: 7 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  body: { flex: 1, minWidth: 0 },
  topLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  from: { flex: 1, fontFamily: fonts.ui, fontSize: 14.5 },
  starIcon: { marginTop: 1 },
  date: { fontFamily: fonts.mono, fontSize: 11 },
  subjectLine: { marginTop: 1.5 },
  subject: { fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 19 },
  snippetLine: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 1 },
  snippet: { flex: 1, fontFamily: fonts.ui, fontSize: 13, lineHeight: 18 },
  chip: {
    paddingHorizontal: 7,
    paddingVertical: 1.5,
    borderRadius: 4,
    maxWidth: 90,
  },
  chipText: { fontSize: 10.5, fontFamily: fonts.uiMedium },
  actions: { flexDirection: "row" },
  action: {
    width: ACTION_W,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  actionLabel: { fontSize: 11, fontFamily: fonts.uiMedium },
  leftAction: {
    flex: 1,
    justifyContent: "center",
    paddingLeft: 22,
  },
});
