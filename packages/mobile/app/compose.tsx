import React, { useState } from "react";
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
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { composeLabels } from "@mail/shared/src/lib/compose";
import { fonts } from "../lib/theme";
import { useTheme } from "../lib/useTheme";
import { AddressField } from "../components/AddressField";

export default function ComposeScreen(): React.ReactElement | null {
  const { t } = useTheme();
  const s = (mailStore as any)((x: any) => x) as any;
  const [showCc, setShowCc] = useState(false);
  const draft = s.composeDraftId ? s.drafts[s.composeDraftId] : null;
  if (!draft) {
    // Discarded or sent while the modal was open — nothing to edit.
    return null;
  }
  const st = () => mailStore.getState();
  const canSend = draft.to.length > 0;

  const close = () => router.back();

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: t.bg }]} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.header, { borderBottomColor: t.rule }]}>
          <Pressable hitSlop={10} onPress={close}>
            <Ionicons name="chevron-down" size={22} color={t.inkMuted} />
          </Pressable>
          <Text style={[styles.title, { color: t.ink }]}>{composeLabels(draft.mode).title}</Text>
          <View style={styles.headerActions}>
            <Pressable
              hitSlop={8}
              onPress={() => {
                st().discardCompose();
                close();
              }}
            >
              <Ionicons name="trash-outline" size={19} color={t.inkFaint} />
            </Pressable>
            <Pressable
              hitSlop={8}
              disabled={!canSend}
              onPress={() => {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                st().sendCompose();
                close();
              }}
              style={[
                styles.sendBtn,
                { backgroundColor: canSend ? t.accent : t.bgSunken },
              ]}
            >
              <Ionicons
                name="arrow-up"
                size={17}
                color={canSend ? t.accentInk : t.inkFaint}
              />
            </Pressable>
          </View>
        </View>

        <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
          <AddressField
            label="To"
            value={draft.to}
            autoFocus={draft.to.length === 0}
            onChange={(to) => st().updateComposeDraft({ to })}
          />
          {showCc || draft.cc.length > 0 ? (
            <AddressField
              label="Cc"
              value={draft.cc}
              onChange={(cc) => st().updateComposeDraft({ cc })}
            />
          ) : (
            <Pressable onPress={() => setShowCc(true)} style={styles.ccToggle}>
              <Text style={[styles.ccText, { color: t.inkFaint }]}>Add Cc</Text>
            </Pressable>
          )}
          <View style={[styles.field, { borderBottomColor: t.rule }]}>
            <TextInput
              value={draft.subject}
              onChangeText={(subject) => st().updateComposeDraft({ subject })}
              placeholder="Subject"
              placeholderTextColor={t.inkFaint}
              style={[styles.subject, { color: t.ink }]}
            />
          </View>
          <TextInput
            multiline
            value={draft.body_text}
            onChangeText={(body_text) => st().updateComposeDraft({ body_text })}
            placeholder="Write…"
            placeholderTextColor={t.inkFaint}
            autoFocus={draft.to.length > 0}
            style={[styles.body, { color: t.ink }]}
          />
        </ScrollView>
        <Text style={[styles.saves, { color: t.inkFaint }]}>
          draft saves as you type
        </Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontFamily: fonts.uiSemiBold, fontSize: 16 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 16 },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  field: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  ccToggle: { paddingHorizontal: 16, paddingVertical: 7 },
  ccText: { fontFamily: fonts.ui, fontSize: 12.5 },
  subject: { flex: 1, fontFamily: fonts.uiMedium, fontSize: 15.5, paddingVertical: 3 },
  body: {
    flex: 1,
    fontFamily: fonts.ui,
    fontSize: 15.5,
    lineHeight: 23,
    padding: 16,
    minHeight: 240,
    textAlignVertical: "top",
  },
  saves: {
    fontFamily: fonts.ui,
    fontSize: 11.5,
    textAlign: "center",
    paddingVertical: 6,
  },
});
