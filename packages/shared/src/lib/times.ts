// The snooze and follow-up time menus. Pure functions of "now" so the picker,
// its tests, and mobile all agree on what "Tomorrow morning" means.

export type TimeOption = { label: string; detail: string; at: number };

function at(base: Date, dayOffset: number, hour: number): number {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function fmt(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Snooze: when should this leave me alone until. */
export function snoozeOptions(now = Date.now()): TimeOption[] {
  const base = new Date(now);
  const options: TimeOption[] = [];
  // +3h, rounded up to the next half hour — "later" should land on a clean time.
  const later = new Date(now + 3 * 60 * 60 * 1000);
  later.setMinutes(later.getMinutes() % 30 === 0 ? later.getMinutes() : later.getMinutes() + (30 - (later.getMinutes() % 30)), 0, 0);
  options.push({ label: "Later today", detail: fmt(later.getTime()), at: later.getTime() });
  if (base.getHours() < 17) {
    options.push({ label: "This evening", detail: fmt(at(base, 0, 18)), at: at(base, 0, 18) });
  }
  options.push({ label: "Tomorrow morning", detail: fmt(at(base, 1, 9)), at: at(base, 1, 9) });
  const toSaturday = (6 - base.getDay() + 7) % 7 || 7;
  options.push({ label: "This weekend", detail: fmt(at(base, toSaturday, 9)), at: at(base, toSaturday, 9) });
  const toMonday = (1 - base.getDay() + 7) % 7 || 7;
  options.push({ label: "Next week", detail: fmt(at(base, toMonday, 9)), at: at(base, toMonday, 9) });
  // On a Friday, "tomorrow morning" IS the weekend — collapse duplicates.
  const seen = new Set<number>();
  return options.filter((o) => !seen.has(o.at) && seen.add(o.at));
}

/** Follow-up watch: nudge me if nobody has replied by then. */
export function followupOptions(now = Date.now()): TimeOption[] {
  const base = new Date(now);
  const toMonday = (1 - base.getDay() + 7) % 7 || 7;
  return [
    { label: "Tomorrow", detail: fmt(at(base, 1, 9)), at: at(base, 1, 9) },
    { label: "In two days", detail: fmt(at(base, 2, 9)), at: at(base, 2, 9) },
    { label: "In three days", detail: fmt(at(base, 3, 9)), at: at(base, 3, 9) },
    { label: "Next week", detail: fmt(at(base, toMonday, 9)), at: at(base, toMonday, 9) },
  ];
}

/** "Tue 9:00 AM" / "in 3h" style due label for reminder chips. */
export function dueLabel(remindAt: number, now = Date.now()): string {
  const delta = remindAt - now;
  if (delta < 60 * 60 * 1000) return `in ${Math.max(1, Math.round(delta / 60000))}m`;
  if (delta < 24 * 60 * 60 * 1000) return `in ${Math.round(delta / 3600000)}h`;
  return new Date(remindAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
