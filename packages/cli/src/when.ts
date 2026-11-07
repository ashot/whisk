// "When" expressions for snooze and follow-up: a duration ("3h", "2d",
// "45m", "1w"), a named moment ("tomorrow", "tonight", "weekend",
// "next week", "monday 9am", "fri"), a time today ("5pm", "17:30"), or an
// ISO date/time. Mornings land at 9:00, evenings at 18:00, like the app's
// snooze menu (@mail/shared/src/lib/times).

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MORNING = 9;
const EVENING = 18;

function at(base: Date, dayOffset: number, hour: number, minute = 0): number {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function parseClock(text: string): { hour: number; minute: number } | null {
  const m = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (!ampm && !m[2] && hour <= 7) hour += 12; // a bare "5" means 5pm
  return { hour, minute };
}

/** Epoch millis for `text`, or null when it is not a time we understand. */
export function parseWhen(text: string, now: number = Date.now(), strictLocalTime = false): number | null {
  const base = new Date(now);
  const moment = (offset: number, hour: number, minute = 0): number | null => {
    const result = at(base, offset, hour, minute);
    const date = new Date(result);
    return strictLocalTime && (date.getHours() !== hour || date.getMinutes() !== minute) ? null : result;
  };
  const raw = text.trim().toLowerCase().replace(/^(in|at|on)\s+/, "");
  if (!raw) return null;

  const duration = raw.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|weeks?)$/);
  if (duration) {
    const n = Number(duration[1]);
    const unit = duration[2][0];
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit]!;
    return now + Math.round(n * ms);
  }

  if (raw === "tomorrow" || raw === "tomorrow morning") return moment(1, MORNING);
  if (raw === "tonight" || raw === "this evening" || raw === "evening") return moment(0, EVENING);
  if (raw === "morning") return moment(base.getHours() < MORNING ? 0 : 1, MORNING);
  if (raw === "later" || raw === "later today") return now + 3 * 3_600_000;
  if (raw === "weekend" || raw === "this weekend") {
    return moment((6 - base.getDay() + 7) % 7 || 7, MORNING);
  }
  if (raw === "next week" || raw === "monday" && false) {
    return moment((1 - base.getDay() + 7) % 7 || 7, MORNING);
  }

  // "<day> [time]" — the next such day, never today.
  const dayMatch = raw.match(/^(?:next\s+)?([a-z]+)(?:\s+(.+))?$/);
  if (dayMatch) {
    const index = DAY_NAMES.findIndex((d) => d.startsWith(dayMatch[1]) && dayMatch[1].length >= 3);
    if (index >= 0) {
      const offset = (index - base.getDay() + 7) % 7 || 7;
      const clock = dayMatch[2] ? parseClock(dayMatch[2]) : null;
      if (dayMatch[2] && !clock) return null;
      return moment(offset, clock?.hour ?? MORNING, clock?.minute ?? 0);
    }
  }

  // "tomorrow 3pm"
  const tomorrowAt = raw.match(/^tomorrow\s+(.+)$/);
  if (tomorrowAt) {
    const clock = parseClock(tomorrowAt[1]);
    return clock ? moment(1, clock.hour, clock.minute) : null;
  }

  // A clock time: today if still ahead, else tomorrow.
  const clock = parseClock(raw);
  if (clock) {
    const today = moment(0, clock.hour, clock.minute);
    return today === null || today > now ? today : moment(1, clock.hour, clock.minute);
  }

  // ISO date or date-time, in local time.
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const parsed = new Date(raw.length === 10 ? `${raw}T${String(MORNING).padStart(2, "0")}:00` : raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }
  return null;
}

/** Same rules, but a bad expression throws with the accepted forms. */
export function whenOrThrow(text: string, now: number = Date.now()): number {
  const ts = parseWhen(text, now);
  if (ts === null) {
    throw new Error(
      `Cannot read "${text}" as a time. Try: 3h, 2d, tomorrow, tonight, weekend, "next week", "mon 9am", 5pm, 2026-09-10 14:00`,
    );
  }
  if (ts <= now) throw new Error(`"${text}" is in the past`);
  return ts;
}

export { parseSince } from "@platform/cli-kit/text";
