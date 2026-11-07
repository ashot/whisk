import React, { useMemo, useState } from "react";
import { Linking } from "react-native";
import { WebView } from "react-native-webview";
import { fonts, type Theme } from "../lib/theme";

// HTML mail in an auto-height WebView — the native analogue of the web app's
// sandboxed iframe. Scripts are stripped before insertion AND JS in the frame
// is limited to our measuring snippet; links open in the system browser, never
// navigate the frame.

function stripActiveContent(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "");
}

const MEASURE = `
  (function() {
    var last = 0;
    function post() {
      var h = document.body ? document.body.scrollHeight : 0;
      if (h && Math.abs(h - last) > 2) {
        last = h;
        window.ReactNativeWebView.postMessage(String(h));
      }
    }
    var ro = window.ResizeObserver && new ResizeObserver(post);
    if (ro && document.body) ro.observe(document.body);
    window.addEventListener("load", post);
    setTimeout(post, 60);
    setTimeout(post, 400);
    setTimeout(post, 1200);
  })();
  true;
`;

export function HtmlBody({
  html,
  t,
  mode,
}: {
  html: string;
  t: Theme;
  mode: "light" | "dark";
}): React.ReactElement {
  const [height, setHeight] = useState(120);

  const doc = useMemo(() => {
    const safe = stripActiveContent(html);
    // Near-white body backgrounds sit on the warm page instead of pasting a
    // white card over it (same trick as the web reader).
    const css = `
      html, body { margin: 0; padding: 0; background: transparent; }
      body {
        font-family: Georgia, 'Times New Roman', serif;
        font-size: 16px; line-height: 1.55; color: ${t.ink};
        overflow-wrap: break-word; -webkit-text-size-adjust: 100%;
      }
      img { max-width: 100% !important; height: auto; }
      a { color: ${t.accent}; }
      blockquote { margin: 0; padding-left: 0.75em; border-left: 2px solid ${t.ruleStrong}; color: ${t.inkMuted}; }
      pre { white-space: pre-wrap; }
      table { max-width: 100% !important; }
    `;
    return `<!doctype html><html style="color-scheme: ${mode};"><head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
      <style>${css}</style>
    </head><body>${safe}</body></html>`;
  }, [html, t, mode]);

  return (
    <WebView
      originWhitelist={["about:blank"]}
      source={{ html: doc }}
      injectedJavaScript={MEASURE}
      onMessage={(e) => {
        const h = Number(e.nativeEvent.data);
        if (Number.isFinite(h) && h > 0) setHeight(Math.min(h + 12, 20000));
      }}
      onShouldStartLoadWithRequest={(req) => {
        if (req.url === "about:blank" || req.url.startsWith("data:")) return true;
        void Linking.openURL(req.url).catch(() => {});
        return false;
      }}
      scrollEnabled={false}
      showsVerticalScrollIndicator={false}
      setSupportMultipleWindows={false}
      androidLayerType="software"
      style={{ height, backgroundColor: "transparent" }}
    />
  );
}
