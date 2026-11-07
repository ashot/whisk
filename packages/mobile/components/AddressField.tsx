import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { suggestRecipients, type Contact } from "@mail/shared/src/store/contacts";
import { addRecipients, parseAddresses } from "@mail/shared/src/lib/compose";
import type { Address } from "@mail/shared/src/store/types";
import { fonts } from "../lib/theme";
import { useTheme } from "../lib/useTheme";

/** A recipient field: chips for who is on it, and the people already in the
 *  mailbox offered as you type. The compose screen and the composer inside a
 *  thread both use it. */
export function AddressField({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: Address[];
  onChange: (a: Address[]) => void;
  autoFocus?: boolean;
}): React.ReactElement {
  const { t } = useTheme();
  const [text, setText] = useState("");
  const hits = suggestRecipients(mailStore.getState() as any, text, value);
  const add = (added: Address[]) => {
    const next = addRecipients(value, added);
    if (next !== value) onChange(next);
    setText("");
  };
  const pick = (c: Contact) => add([c.name ? { name: c.name, email: c.email } : { email: c.email }]);
  const commit = () => {
    const { addresses } = parseAddresses(text);
    if (addresses.length > 0) add(addresses);
  };
  return (
    <View style={[styles.wrap, { borderBottomColor: t.rule }]}>
      <View style={styles.field}>
        <Text style={[styles.label, { color: t.inkFaint }]}>{label}</Text>
        <View style={styles.chips}>
          {value.map((a) => (
            <Pressable
              key={a.email}
              onPress={() => onChange(value.filter((v) => v.email !== a.email))}
              style={[styles.chip, { backgroundColor: t.bgSunken }]}
            >
              <Text style={[styles.chipText, { color: t.ink }]}>{a.name ?? a.email}</Text>
              <Ionicons name="close" size={12} color={t.inkFaint} />
            </Pressable>
          ))}
          <TextInput
            value={text}
            onChangeText={setText}
            onBlur={commit}
            // Return takes the top suggestion, else what was typed.
            onSubmitEditing={() => (hits[0] ? pick(hits[0]) : commit())}
            autoFocus={autoFocus}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={value.length === 0 ? "name@example.com" : ""}
            placeholderTextColor={t.inkFaint}
            style={[styles.input, { color: t.ink }]}
          />
        </View>
      </View>
      {hits.map((c) => (
        <Pressable
          key={c.email}
          onPress={() => pick(c)}
          style={({ pressed }) => [styles.hit, pressed && { backgroundColor: t.bgHover }]}
        >
          <Text numberOfLines={1} style={[styles.hitName, { color: t.ink }]}>
            {c.name ?? c.email}
          </Text>
          {c.name && (
            <Text numberOfLines={1} style={[styles.hitEmail, { color: t.inkFaint }]}>
              {c.email}
            </Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderBottomWidth: StyleSheet.hairlineWidth },
  field: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  label: { fontFamily: fonts.ui, fontSize: 13.5, paddingTop: 4 },
  chips: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 12,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  chipText: { fontFamily: fonts.ui, fontSize: 13 },
  input: { minWidth: 140, flexGrow: 1, fontFamily: fonts.ui, fontSize: 14.5, paddingVertical: 3 },
  hit: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  hitName: { fontFamily: fonts.uiMedium, fontSize: 14.5, flexShrink: 1 },
  hitEmail: { fontFamily: fonts.mono, fontSize: 12, flexShrink: 1 },
});
