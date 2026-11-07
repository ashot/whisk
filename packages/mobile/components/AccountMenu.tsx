import React, { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { Account } from "@mail/shared/src/store/types";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { initials } from "@mail/shared/src/lib/format";
import { ACCOUNT_INK, accountColor } from "@mail/shared/src/store/selectors";
import { attachDemoMailbox, connectGmail } from "../lib/auth";
import { fonts, type Theme } from "../lib/theme";

// The account switcher, mirroring the web rail: unified view, one row per
// account, add. Anchored under the header's avatar button as a light popover.

function AcctDot({
  account,
  mode,
  size = 26,
}: {
  account: Account;
  mode: "light" | "dark";
  size?: number;
}): React.ReactElement {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: accountColor(mailStore.getState().accounts, account._id),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontFamily: fonts.mono, fontSize: size * 0.36, color: ACCOUNT_INK }}>
        {initials({ name: account.name, email: account.email })}
      </Text>
    </View>
  );
}

/** The header button: the scoped account's dot, or a neutral glyph for the
 *  unified view. Opens the switcher. */
export function AccountButton({
  accounts,
  scope,
  t,
  mode,
}: {
  accounts: Account[];
  scope: string;
  t: Theme;
  mode: "light" | "dark";
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const scoped = scope !== "all" ? accounts.find((a) => a._id === scope) : undefined;
  const st = () => mailStore.getState();

  const choose = (next: string) => {
    st().setAccountScope(next as any);
    setOpen(false);
  };

  return (
    <>
      <Pressable hitSlop={8} onPress={() => setOpen(true)}>
        {scoped ? (
          <AcctDot account={scoped} mode={mode} />
        ) : accounts.length > 1 ? (
          <View style={[styles.allDot, { borderColor: t.inkMuted }]}>
            <Text style={[styles.allDotText, { color: t.inkMuted }]}>∞</Text>
          </View>
        ) : accounts[0] ? (
          <AcctDot account={accounts[0]} mode={mode} />
        ) : (
          <Ionicons name="person-circle-outline" size={23} color={t.inkMuted} />
        )}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable
            style={[
              styles.card,
              { backgroundColor: t.bgRaised, borderColor: t.rule, shadowColor: "#000" },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            {accounts.length > 1 && (
              <Pressable
                onPress={() => choose("all")}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: pressed ? t.bgHover : "transparent" },
                ]}
              >
                <View style={[styles.allDot, { borderColor: t.inkMuted }]}>
                  <Text style={[styles.allDotText, { color: t.inkMuted }]}>∞</Text>
                </View>
                <Text style={[styles.rowText, { color: t.ink }]}>All inboxes</Text>
                {scope === "all" && <Ionicons name="checkmark" size={16} color={t.accent} />}
              </Pressable>
            )}
            {accounts.map((a) => (
              <Pressable
                key={a._id}
                onPress={() => choose(a._id)}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: pressed ? t.bgHover : "transparent" },
                ]}
              >
                <AcctDot account={a} mode={mode} />
                <Text numberOfLines={1} style={[styles.rowText, { color: t.ink }]}>
                  {a.email}
                </Text>
                {a.sync_status === "backfilling" || a.sync_status === "syncing" ? (
                  <ActivityIndicator size="small" color={t.inkFaint} />
                ) : scope === a._id ? (
                  <Ionicons name="checkmark" size={16} color={t.accent} />
                ) : null}
              </Pressable>
            ))}
            <View style={[styles.rule, { backgroundColor: t.rule }]} />
            <Pressable
              disabled={connecting}
              onPress={async () => {
                setConnecting(true);
                try {
                  // A demo session grows with demo mailboxes; a real session
                  // attaches another Gmail through the OAuth flow.
                  if (accounts.length > 0 && accounts.every((a) => a.provider === "demo")) {
                    await attachDemoMailbox();
                  } else {
                    await connectGmail();
                  }
                } catch {}
                setConnecting(false);
                setOpen(false);
              }}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? t.bgHover : "transparent" },
              ]}
            >
              <View style={[styles.allDot, { borderColor: t.ruleStrong, borderStyle: "dashed" }]}>
                {connecting ? (
                  <ActivityIndicator size="small" color={t.accent} />
                ) : (
                  <Ionicons name="add" size={15} color={t.accent} />
                )}
              </View>
              <Text style={[styles.rowText, { color: t.inkMuted }]}>Add account</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setOpen(false);
                router.push("/settings");
              }}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? t.bgHover : "transparent" },
              ]}
            >
              <View style={styles.gear}>
                <Ionicons name="settings-outline" size={16} color={t.inkMuted} />
              </View>
              <Text style={[styles.rowText, { color: t.inkMuted }]}>Settings</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(20, 16, 12, 0.25)",
  },
  card: {
    position: "absolute",
    top: 64,
    right: 12,
    minWidth: 250,
    maxWidth: 330,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 6,
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  rowText: { flex: 1, fontFamily: fonts.uiMedium, fontSize: 13.5 },
  allDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.2,
    alignItems: "center",
    justifyContent: "center",
  },
  allDotText: { fontSize: 13, lineHeight: 15 },
  gear: { width: 26, alignItems: "center" },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 5 },
});
