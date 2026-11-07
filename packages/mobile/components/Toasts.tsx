import React, { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Reanimated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { fonts } from "../lib/theme";
import { useTheme } from "../lib/useTheme";

// The store's toast queue, rendered natively. Undo toasts get their action
// button; everything else auto-expires.

export function Toasts(): React.ReactElement | null {
  const { t } = useTheme();
  const toasts = (mailStore as any)((s: any) => s.toasts) as Array<{
    id: number;
    text: string;
    kind: "info" | "undo" | "error";
    expiresAt: number;
  }>;

  useEffect(() => {
    if (toasts.length === 0) return;
    const next = Math.min(...toasts.map((x) => x.expiresAt)) - Date.now();
    const timer = setTimeout(() => {
      const st = mailStore.getState();
      const now = Date.now();
      for (const toast of st.toasts) {
        if (toast.expiresAt <= now) st.dismissToast(toast.id);
      }
    }, Math.max(next, 50));
    return () => clearTimeout(timer);
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <View pointerEvents="box-none" style={styles.host}>
      {toasts.slice(-2).map((toast) => (
        <Reanimated.View
          key={toast.id}
          entering={FadeInDown.duration(160)}
          exiting={FadeOutDown.duration(120)}
          style={[
            styles.toast,
            {
              backgroundColor: toast.kind === "error" ? t.danger : t.ink,
            },
          ]}
        >
          <Text style={[styles.text, { color: t.bgRaised }]}>{toast.text}</Text>
          {toast.kind === "undo" && (
            <Pressable
              onPress={() => mailStore.getState().undo()}
              hitSlop={10}
            >
              <Text style={[styles.undo, { color: t.star }]}>Undo</Text>
            </Pressable>
          )}
        </Reanimated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 34,
    alignItems: "center",
    gap: 8,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 22,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  text: { fontFamily: fonts.uiMedium, fontSize: 13.5 },
  undo: { fontFamily: fonts.uiSemiBold, fontSize: 13.5 },
});
