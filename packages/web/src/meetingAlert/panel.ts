// The desktop app's meeting card: a small frameless window the shell floats
// over every app and Space (packages/desktop/main.js, "meeting-alert"). The
// shell owns the list of meetings showing; this page draws it, plays the
// sound for a stage that just arrived, reports its height so the window fits,
// and sends back what the person clicked. The main app decides when a
// meeting alerts (lib/meetingAlerts).
import "../design/base";
import "./panel.css";
import soonSound from "@mail/shared/assets/sounds/meeting-soon.wav?url";
import nowSound from "@mail/shared/assets/sounds/meeting-now.wav?url";
import { meetingProvider } from "@mail/shared/src/lib/calendar";
import { desktopBridge } from "../lib/desktopBridge";
import type { MeetingAlertPayload } from "../lib/meetingAlerts";

type PanelState = { alerts: MeetingAlertPayload[]; chime: "soon" | "now" | null };

const bridge = desktopBridge();
const root = document.getElementById("alerts")!;
let alerts: MeetingAlertPayload[] = [];

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function when(alert: MeetingAlertPayload, now: number): string {
  const ms = alert.start - now;
  if (ms > 45_000) return `In ${Math.round(ms / 60_000) || 1} min`;
  if (ms > -60_000) return "Starting now";
  return `Started ${Math.round(-ms / 60_000)} min ago`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function act(key: string, action: "join" | "open" | "dismiss"): void {
  void bridge?.call("meeting-alert-action", { key, action });
}

function card(alert: MeetingAlertPayload, now: number): HTMLElement {
  const starting = alert.start - now <= 45_000;
  const article = el("article", `meeting${starting ? " is-now" : ""}`);
  article.dataset.key = alert.key;
  if (alert.color) article.style.setProperty("--calendar", alert.color);

  const top = el("div", "meeting-top");
  const status = el("span", "meeting-when");
  status.append(el("span", "meeting-dot"), document.createTextNode(when(alert, now)));
  const close = el("button", "meeting-close", "×");
  close.setAttribute("aria-label", "Dismiss");
  close.onclick = () => act(alert.key, "dismiss");
  top.append(status, close);

  const title = el("h1", "meeting-title", alert.title);
  title.onclick = () => act(alert.key, "open");

  const meta = el("p", "meeting-meta", [`${clock.format(alert.start)} – ${clock.format(alert.end)}`, alert.where].filter(Boolean).join(" · "));

  const actions = el("div", "meeting-actions");
  if (alert.join) {
    const provider = meetingProvider(alert.join);
    const join = el("button", "meeting-join", provider ? `Join ${provider}` : "Join");
    join.onclick = () => act(alert.key, "join");
    actions.append(join);
  }
  const open = el("button", "meeting-open", "Open in Calendar");
  open.onclick = () => act(alert.key, "open");
  actions.append(open);

  article.append(top, title, meta, actions);
  return article;
}

function render(): void {
  const now = Date.now();
  const seen = new Set([...root.children].map((c) => (c as HTMLElement).dataset.key));
  root.replaceChildren(
    ...alerts.map((a) => {
      const node = card(a, now);
      // Only a card that just arrived slides in; a redraw stays put.
      if (!seen.has(a.key)) node.classList.add("is-new");
      return node;
    }),
  );
}

function apply(state: PanelState | null): void {
  if (!state) return;
  alerts = state.alerts;
  render();
  if (state.chime) void new Audio(state.chime === "now" ? nowSound : soonSound).play().catch(() => {});
}

// The window is as tall as its cards.
new ResizeObserver(() => {
  void bridge?.call("meeting-alert-size", Math.ceil(root.getBoundingClientRect().height));
}).observe(root);

// "In 3 min" keeps counting.
setInterval(() => {
  for (const node of root.querySelectorAll<HTMLElement>(".meeting")) {
    const alert = alerts.find((a) => a.key === node.dataset.key);
    if (!alert) continue;
    const now = Date.now();
    node.querySelector(".meeting-when")!.lastChild!.textContent = when(alert, now);
    node.classList.toggle("is-now", alert.start - now <= 45_000);
  }
}, 5_000);

window.addEventListener("keydown", (e) => {
  const first = alerts[0];
  if (!first) return;
  if (e.key === "Escape") act(first.key, "dismiss");
  if (e.key === "Enter") act(first.key, first.join ? "join" : "open");
});

if (bridge) {
  bridge.subscribe("meeting-alerts", (state) => apply(state as PanelState));
  void bridge.call("meeting-alert-state").then((state) => apply(state as PanelState));
}
