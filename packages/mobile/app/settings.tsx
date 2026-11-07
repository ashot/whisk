import React, { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Updates from "expo-updates";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { api } from "@mail/convex/convex/_generated/api";
import { relativeDate } from "@mail/shared/src/lib/format";
import { useServerList } from "@mail/shared/src/lib/serverList";
import { convexClient } from "../lib/convex";
import { connectGmail, disconnectAccount, refreshSync, signOut } from "../lib/auth";
import { sendTestPush } from "../lib/push";
import { normalizePrefs } from "@mail/shared/src/lib/notifications";
import { allAccounts } from "../lib/account";
import { fonts } from "../lib/theme";
import { useTheme } from "../lib/useTheme";
import { Avatar } from "../components/Avatar";
import { accountHealth } from "@mail/shared/src/lib/accountHealth";
import type { Account } from "@mail/shared/src/store/types";
import type { Theme } from "../lib/theme";

// One connected mailbox: who it is, whether it is actually syncing, and the
// fixes — the same reading and remedies as the web settings page.
function AccountCard({
  account,
  t,
  mode,
}: {
  account: Account;
  t: Theme;
  mode: "light" | "dark";
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const health = accountHealth(account);
  const gmail = account.provider === "gmail";
  const bad = health.kind === "reconnect" || health.kind === "error";
  const syncNow = async () => {
    setBusy(true);
    await refreshSync();
    setBusy(false);
    mailStore.getState().pushToast("Syncing…");
  };
  const disconnect = () =>
    Alert.alert(
      `Disconnect ${account.email}?`,
      "Whisk's access is revoked and its synced copy is deleted from Whisk's servers. Your mail stays in Gmail.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () =>
            void disconnectAccount(account._id).catch((e) =>
              mailStore.getState().pushToast(String((e as Error).message ?? e), "error"),
            ),
        },
      ],
    );

  return (
    <View
      style={[
        styles.accountRow,
        { backgroundColor: t.bgRaised, borderColor: bad ? t.danger : t.rule },
      ]}
    >
      <View style={styles.accountTop}>
        <Avatar address={{ name: account.name, email: account.email }} size={36} theme={t} mode={mode} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={[styles.accountName, { color: t.ink }]}>
            {account.email}
          </Text>
          <Text numberOfLines={1} style={[styles.accountEmail, { color: bad ? t.danger : t.inkFaint }]}>
            {health.label}
          </Text>
        </View>
      </View>
      {health.detail && (
        <Text style={[styles.accountDetail, { color: t.danger }]}>{health.detail}</Text>
      )}
      <View style={styles.accountActions}>
        {gmail && health.kind === "reconnect" && (
          <Pressable
            onPress={() => void connectGmail(account.email)}
            style={[styles.smallBtn, { backgroundColor: t.accent, borderColor: t.accent }]}
          >
            <Text style={[styles.smallBtnText, { color: t.bgRaised }]}>Reconnect</Text>
          </Pressable>
        )}
        {gmail && health.kind !== "reconnect" && (
          <Pressable
            disabled={busy || health.kind === "busy"}
            onPress={() => void syncNow()}
            style={[styles.smallBtn, { borderColor: t.ruleStrong, opacity: busy ? 0.6 : 1 }]}
          >
            <Text style={[styles.smallBtnText, { color: t.ink }]}>Sync now</Text>
          </Pressable>
        )}
        <Pressable onPress={disconnect} style={[styles.smallBtn, { borderColor: "transparent" }]}>
          <Text style={[styles.smallBtnText, { color: t.inkMuted }]}>Disconnect…</Text>
        </Pressable>
      </View>
    </View>
  );
}

type Connection = FunctionReturnType<typeof api.connect.list>[number];

// Apps connected through whisk.email/connect (codecast first), the same list
// and revoke as the web's Settings. Read from the server, because a revoke
// only means something once the server has it.
function ConnectedApps({ t }: { t: Theme }): React.ReactElement | null {
  const { rows: apps, change } = useServerList((token) =>
    convexClient().query(api.connect.list, { token }),
  );
  const revoke = (app: Connection) =>
    Alert.alert(`Revoke ${app.name}?`, `${app.name} stops reaching your mail and calendar at once.`, [
      { text: "Keep", style: "cancel" },
      {
        text: "Revoke",
        style: "destructive",
        onPress: () =>
          void change((token) => convexClient().mutation(api.connect.revoke, { token, connection_id: app._id })),
      },
    ]);

  if (!apps || apps.length === 0) return null;
  return (
    <>
      <Text style={[styles.section, { color: t.inkFaint }]}>CONNECTED APPS</Text>
      {apps.map((a) => (
        <View key={a._id} style={[styles.accountRow, { backgroundColor: t.bgRaised, borderColor: t.rule }]}>
          <View style={{ gap: 2 }}>
            <Text style={[styles.accountName, { color: t.ink }]}>{a.name}</Text>
            <Text style={[styles.accountEmail, { color: t.inkFaint }]}>
              connected {relativeDate(a.connected_at)} · last used {relativeDate(a.last_used_at)}
            </Text>
            <Text style={[styles.accountDetail, { color: t.inkMuted }]}>
              {a.scopes.map((s) => s.label).join(" · ")}
            </Text>
            <Text style={[styles.accountDetail, { color: t.inkFaint }]}>{a.reach}</Text>
          </View>
          <View style={styles.accountActions}>
            <Pressable onPress={() => revoke(a)} style={[styles.smallBtn, { borderColor: "transparent" }]}>
              <Text style={[styles.smallBtnText, { color: t.inkMuted }]}>Revoke…</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </>
  );
}

export default function SettingsScreen(): React.ReactElement {
  const { t, mode } = useTheme();
  const s = (mailStore as any)((x: any) => x) as any;
  const accounts = allAccounts(s);
  const [connecting, setConnecting] = useState(false);
  const st = () => mailStore.getState();

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: t.bg }]} edges={["top", "bottom"]}>
      <View style={[styles.header, { borderBottomColor: t.rule }]}>
        <Pressable hitSlop={10} onPress={() => router.back()}>
          <Ionicons name="chevron-down" size={22} color={t.inkMuted} />
        </Pressable>
        <Text style={[styles.title, { color: t.ink }]}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.section, { color: t.inkFaint }]}>ACCOUNTS</Text>
        {accounts.map((a) => (
          <AccountCard key={a._id} account={a} t={t} mode={mode} />
        ))}

        <Pressable
          disabled={connecting}
          onPress={async () => {
            setConnecting(true);
            await connectGmail();
            setConnecting(false);
          }}
          style={({ pressed }) => [
            styles.action,
            { borderColor: t.ruleStrong, opacity: pressed || connecting ? 0.7 : 1 },
          ]}
        >
          <Ionicons name="add" size={17} color={t.accent} />
          <Text style={[styles.actionText, { color: t.ink }]}>
            {accounts.length > 0 ? "Add another account" : "Connect Gmail"}
          </Text>
        </Pressable>

        <ConnectedApps t={t} />

        <Text style={[styles.section, { color: t.inkFaint }]}>NOTIFICATIONS</Text>
        <Pressable
          onPress={() => {
            const cur = normalizePrefs(s.clientState?.notifications);
            st().setClientPref("notifications", { ...cur, enabled: !cur.enabled });
          }}
          style={[styles.prefRow, { backgroundColor: t.bgRaised, borderColor: t.rule }]}
        >
          <Text style={[styles.prefLabel, { color: t.ink }]}>New mail alerts</Text>
          <Switch
            value={normalizePrefs(s.clientState?.notifications).enabled}
            onValueChange={(on) => {
              const cur = normalizePrefs(s.clientState?.notifications);
              st().setClientPref("notifications", { ...cur, enabled: on });
            }}
            trackColor={{ true: t.accent, false: t.ruleStrong }}
            thumbColor={t.bgRaised}
          />
        </Pressable>
        <Pressable
          onPress={() => {
            const token = s.authToken as string | null;
            if (!token) return;
            void sendTestPush(token)
              .then((r) => {
                if (r.sent > 0) st().pushToast("Test sent — check the lock screen");
                else if (r.reason === "no-device") st().pushToast("This phone is not registered for alerts yet", "error");
                else st().pushToast("Expo rejected the test", "error");
              })
              .catch((e) => st().pushToast(String((e as Error).message ?? e), "error"));
          }}
          style={({ pressed }) => [
            styles.action,
            { borderColor: t.ruleStrong, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.actionText, { color: t.ink }]}>Send a test notification</Text>
        </Pressable>

        <Text style={[styles.section, { color: t.inkFaint }]}>APPEARANCE</Text>
        {/* The whole row toggles — a Switch alone is a small target inside a
            modal sheet, and the label is where the finger goes. */}
        <Pressable
          onPress={() => st().setClientPref("theme", mode === "dark" ? "light" : "dark")}
          style={[styles.prefRow, { backgroundColor: t.bgRaised, borderColor: t.rule }]}
        >
          <Text style={[styles.prefLabel, { color: t.ink }]}>Dark theme</Text>
          <Switch
            value={mode === "dark"}
            onValueChange={(on) => st().setClientPref("theme", on ? "dark" : "light")}
            trackColor={{ true: t.accent, false: t.ruleStrong }}
            thumbColor={t.bgRaised}
          />
        </Pressable>

        <Text style={[styles.section, { color: t.inkFaint }]}>ABOUT</Text>
        <View style={[styles.prefRow, { backgroundColor: t.bgRaised, borderColor: t.rule }]}>
          <Text style={[styles.prefLabel, { color: t.ink }]}>Version</Text>
          <Text style={[styles.prefValue, { color: t.inkFaint }]}>
            {Updates.runtimeVersion ?? "dev"}
            {Updates.updateId ? `  ·  ${Updates.updateId.slice(0, 8)}` : ""}
          </Text>
        </View>

        <Pressable
          onPress={() => {
            signOut();
            router.back();
          }}
          style={({ pressed }) => [
            styles.signOut,
            { borderColor: t.danger, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.signOutText, { color: t.danger }]}>Sign out</Text>
        </Pressable>
      </ScrollView>
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
  title: { fontFamily: fonts.uiSemiBold, fontSize: 16 },
  content: { padding: 16, gap: 8 },
  section: {
    fontFamily: fonts.mono,
    fontSize: 10.5,
    letterSpacing: 1.4,
    marginTop: 14,
    marginBottom: 2,
  },
  accountRow: {
    gap: 10,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  accountTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  accountDetail: { fontFamily: fonts.ui, fontSize: 12.5, lineHeight: 17 },
  accountActions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  smallBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  smallBtnText: { fontFamily: fonts.uiMedium, fontSize: 13 },
  accountName: { fontFamily: fonts.uiSemiBold, fontSize: 14.5 },
  accountEmail: { fontFamily: fonts.mono, fontSize: 11.5, marginTop: 1 },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 10,
    padding: 13,
    justifyContent: "center",
  },
  actionText: { fontFamily: fonts.uiMedium, fontSize: 14 },
  prefRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  prefLabel: { fontFamily: fonts.ui, fontSize: 14.5 },
  prefValue: { fontFamily: fonts.mono, fontSize: 11.5 },
  signOut: {
    marginTop: 22,
    borderWidth: 1,
    borderRadius: 10,
    padding: 13,
    alignItems: "center",
  },
  signOutText: { fontFamily: fonts.uiMedium, fontSize: 14.5 },
});
