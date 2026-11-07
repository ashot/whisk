import React, { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useFonts } from "expo-font";
import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
} from "@expo-google-fonts/instrument-sans";
import {
  Newsreader_400Regular,
  Newsreader_500Medium_Italic,
  Newsreader_600SemiBold,
} from "@expo-google-fonts/newsreader";
import { FragmentMono_400Regular } from "@expo-google-fonts/fragment-mono";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { useMailSync } from "../lib/sync";
import { usePushNotifications } from "../lib/push";
import { useTheme } from "../lib/useTheme";
import { Toasts } from "../components/Toasts";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout(): React.ReactElement | null {
  const { t, mode } = useTheme();
  useMailSync();
  usePushNotifications();

  const [fontsLoaded] = useFonts({
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
    Newsreader_400Regular,
    Newsreader_500Medium_Italic,
    Newsreader_600SemiBold,
    FragmentMono_400Regular,
  });

  // Keep the splash up until we know what the first screen is: the cache has
  // hydrated, and a stored login has either produced its roster or been
  // rejected. Without this the inbox shell and the welcome card each flash
  // for a frame before the real screen. Capped so a dead network still
  // reaches the in-app spinner instead of a frozen splash.
  const decided = (mailStore as any)(
    (s: any) => s.hydrated && !(s.authToken && Object.keys(s.accounts ?? {}).length === 0),
  ) as boolean;
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!fontsLoaded) return;
    const id = setTimeout(() => setTimedOut(true), 3000);
    return () => clearTimeout(id);
  }, [fontsLoaded]);
  useEffect(() => {
    if (fontsLoaded && (decided || timedOut)) void SplashScreen.hideAsync();
  }, [fontsLoaded, decided, timedOut]);

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar style={mode === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="thread/[id]" />
        <Stack.Screen
          name="compose"
          options={{ presentation: "modal", gestureEnabled: true }}
        />
        <Stack.Screen
          name="settings"
          options={{ presentation: "modal", gestureEnabled: true }}
        />
      </Stack>
      <Toasts />
    </GestureHandlerRootView>
  );
}
