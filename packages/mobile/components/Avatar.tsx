import React from "react";
import { Text, View } from "react-native";
import type { Address } from "@mail/shared/src/store/types";
import { initials, senderHue } from "@mail/shared/src/lib/format";
import { avatarColor, fonts, type Theme } from "../lib/theme";

export function Avatar({
  address,
  size = 34,
  theme,
  mode,
  accented,
}: {
  address: Address;
  size?: number;
  theme: Theme;
  mode: "light" | "dark";
  accented?: boolean;
}): React.ReactElement {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: avatarColor(senderHue(address.email), mode),
        alignItems: "center",
        justifyContent: "center",
        borderWidth: accented ? 2 : 0,
        borderColor: accented ? theme.accent : "transparent",
      }}
    >
      <Text
        style={{
          fontFamily: fonts.mono,
          fontSize: size * 0.34,
          color: theme.bgRaised,
        }}
      >
        {initials(address)}
      </Text>
    </View>
  );
}
