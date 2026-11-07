import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { connectGmail, seedDemo } from "../lib/auth";
import { fonts } from "../lib/theme";
import { useTheme } from "../lib/useTheme";

export function Welcome(): React.ReactElement {
  const { t } = useTheme();
  const [busy, setBusy] = useState<"demo" | "gmail" | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: t.bg }]}>
      <View style={styles.card}>
        <Text style={[styles.mark, { color: t.accent }]}>✉︎</Text>
        <Text style={[styles.title, { color: t.ink }]}>Whisk</Text>
        <Text style={[styles.tag, { color: t.inkMuted }]}>
          Your inbox, at the speed of thought.{"\n"}Swipe to archive, star, and file —
          every gesture lands instantly.
        </Text>

        <Pressable
          disabled={busy !== null}
          onPress={async () => {
            setBusy("gmail");
            setError(null);
            const res = await connectGmail();
            if (!res.ok && res.error) setError(res.error);
            setBusy(null);
          }}
          style={({ pressed }) => [
            styles.primary,
            { backgroundColor: t.accent, opacity: pressed || busy ? 0.85 : 1 },
          ]}
        >
          {busy === "gmail" ? (
            <ActivityIndicator color={t.accentInk} />
          ) : (
            <Text style={[styles.primaryText, { color: t.accentInk }]}>
              Connect Gmail
            </Text>
          )}
        </Pressable>

        <Pressable
          disabled={busy !== null}
          onPress={async () => {
            setBusy("demo");
            setError(null);
            try {
              await seedDemo();
            } catch (e) {
              setError(String((e as Error).message ?? e));
            }
            setBusy(null);
          }}
          style={({ pressed }) => [
            styles.secondary,
            { borderColor: t.ruleStrong, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          {busy === "demo" ? (
            <ActivityIndicator color={t.inkMuted} />
          ) : (
            <Text style={[styles.secondaryText, { color: t.inkMuted }]}>
              Try the demo mailbox
            </Text>
          )}
        </Pressable>

        {error && <Text style={[styles.error, { color: t.danger }]}>{error}</Text>}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, alignItems: "center", justifyContent: "center" },
  card: { alignItems: "center", paddingHorizontal: 36, gap: 14, maxWidth: 420 },
  mark: { fontSize: 34 },
  title: { fontFamily: fonts.readSemiBold, fontSize: 34, marginTop: -6 },
  tag: {
    fontFamily: fonts.ui,
    fontSize: 14.5,
    lineHeight: 22,
    textAlign: "center",
    marginBottom: 12,
  },
  primary: {
    alignSelf: "stretch",
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { fontFamily: fonts.uiSemiBold, fontSize: 15.5 },
  secondary: {
    alignSelf: "stretch",
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: { fontFamily: fonts.uiMedium, fontSize: 15 },
  error: { fontFamily: fonts.ui, fontSize: 13, textAlign: "center" },
});
