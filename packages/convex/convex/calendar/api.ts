import { googleCall, queryString } from "../gmail/api";

// A thin Google Calendar REST client, the calendar twin of gmail/api.ts.
// Pure parsers for tests, `fetch` for the rest. No googleapis.

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export type ResponseStatus = "accepted" | "declined" | "tentative" | "needsAction";

export type ParsedAttendee = {
  email: string;
  name?: string;
  response_status?: string;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
};

export type ParsedEvent = {
  calendar_google_id: string;
  google_id: string;
  ical_uid?: string;
  summary: string;
  description?: string;
  location?: string;
  start: number;
  end: number;
  all_day: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  html_link?: string;
  conference_url?: string;
  native_conference_url?: string;
  attendees: ParsedAttendee[];
  organizer?: { email: string; name?: string; self?: boolean };
  my_response?: ResponseStatus;
  recurring_event_id?: string;
  recurring?: boolean;
};

export type ParsedCalendar = {
  google_id: string;
  summary: string;
  description?: string;
  color?: string;
  foreground?: string;
  primary?: boolean;
  selected?: boolean;
  access_role: string;
  time_zone?: string;
};

// ---------------------------------------------------------------------------
// Wire shapes (the subset we read)
// ---------------------------------------------------------------------------

export type GoogleCalendarListEntry = {
  id: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  primary?: boolean;
  selected?: boolean;
  hidden?: boolean;
  deleted?: boolean;
  accessRole?: string;
  timeZone?: string;
};

export type GoogleEventTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

export type GoogleEvent = {
  id: string;
  etag?: string;
  status?: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  recurringEventId?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
    optional?: boolean;
    resource?: boolean;
  }>;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
  eventType?: string;
  recurrence?: string[];
};

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

/** UTC midnight of a "YYYY-MM-DD" calendar date. */
export function dateToUtcMidnight(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? ms : NaN;
}

/** "YYYY-MM-DD" of a UTC-midnight stamp — the inverse of dateToUtcMidnight. */
export function utcMidnightToDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const VIDEO_LINK =
  /https?:\/\/(?:[a-z0-9-]+\.)?(?:zoom\.us\/(?:j|my|w)\/[^\s<>"')]+|meet\.google\.com\/[a-z0-9-]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"')]+|teams\.live\.com\/meet\/[^\s<>"')]+|whereby\.com\/[^\s<>"')]+|around\.co\/[^\s<>"')]+)/i;

/**
 * The one URL that joins the meeting. Google's own conference first, then a
 * recognisable video link anywhere in the text fields — Zoom pasted into the
 * location is the common case for invitations from outside Google.
 */
export function conferenceUrl(event: GoogleEvent): string | undefined {
  const hangout = safeUrl(event.hangoutLink);
  if (hangout) return hangout;
  const video = event.conferenceData?.entryPoints?.find(
    (p) => p.entryPointType === "video" && safeUrl(p.uri),
  );
  if (video?.uri) return safeUrl(video.uri);
  for (const text of [event.location, event.description]) {
    const m = text?.match(VIDEO_LINK);
    if (m) return safeUrl(m[0]);
  }
  return undefined;
}

export function safeUrl(raw: string | undefined): string | undefined {
  if (!raw || !/^https?:\/\//i.test(raw) || !URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  return url.username || url.password ? undefined : url.href;
}

function parseStatus(raw: string | undefined): ParsedEvent["status"] {
  if (raw === "cancelled" || raw === "tentative") return raw;
  return "confirmed";
}

function parseResponse(raw: string | undefined): ResponseStatus | undefined {
  if (
    raw === "accepted" ||
    raw === "declined" ||
    raw === "tentative" ||
    raw === "needsAction"
  ) {
    return raw;
  }
  return undefined;
}

export function parseGoogleEvent(
  event: GoogleEvent,
  calendarGoogleId: string,
): ParsedEvent | null {
  if (!event.id) return null;
  const allDay = !!event.start?.date;
  let start: number;
  let end: number;
  if (allDay) {
    start = dateToUtcMidnight(event.start!.date!);
    end = event.end?.date ? dateToUtcMidnight(event.end.date) : NaN;
  } else {
    start = Date.parse(event.start?.dateTime ?? "");
    end = Date.parse(event.end?.dateTime ?? "");
    // A cancelled instance in a sync feed can arrive with no times at all;
    // it is still a tombstone we must apply, so give it a harmless span.
    if (!Number.isFinite(start)) {
      if (event.status !== "cancelled") return null;
      start = 0;
    }
    if (!Number.isFinite(end)) end = start;
  }
  if (event.status !== "cancelled" && (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)) return null;
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = start;
  const attendees: ParsedAttendee[] = (event.attendees ?? [])
    .filter((a) => a.email && !a.resource)
    .map((a) => ({
      email: a.email!,
      name: a.displayName || undefined,
      response_status: a.responseStatus,
      self: a.self || undefined,
      organizer: a.organizer || undefined,
      optional: a.optional || undefined,
    }));
  const me = attendees.find((a) => a.self);
  return {
    calendar_google_id: calendarGoogleId,
    google_id: event.id,
    ical_uid: event.iCalUID,
    summary: event.summary ?? "",
    description: event.description || undefined,
    location: event.location || undefined,
    start,
    end,
    all_day: allDay,
    status: parseStatus(event.status),
    html_link: safeUrl(event.htmlLink),
    conference_url: conferenceUrl(event),
    native_conference_url: conferenceUrl({ id: event.id, hangoutLink: event.hangoutLink, conferenceData: event.conferenceData }),
    attendees,
    organizer: event.organizer?.email
      ? {
          email: event.organizer.email,
          name: event.organizer.displayName || undefined,
          self: event.organizer.self || undefined,
        }
      : undefined,
    my_response: me ? parseResponse(me.response_status) : undefined,
    recurring_event_id: event.recurringEventId,
    recurring: event.recurrence?.length ? true : undefined,
  };
}

export function providerEventPatch(event: ParsedEvent): ParsedEvent {
  return {
    ical_uid: undefined, description: undefined, location: undefined, html_link: undefined,
    conference_url: undefined, native_conference_url: undefined, organizer: undefined,
    my_response: undefined, recurring_event_id: undefined, recurring: undefined,
    ...event,
  };
}

export function parseCalendarListEntry(entry: GoogleCalendarListEntry): ParsedCalendar {
  return {
    google_id: entry.id,
    summary: entry.summaryOverride || entry.summary || entry.id,
    description: entry.description || undefined,
    color: entry.backgroundColor,
    foreground: entry.foregroundColor,
    primary: entry.primary || undefined,
    // Google's `selected` is absent for calendars hidden from its own UI.
    selected: !!entry.primary || (entry.selected === true && !entry.hidden),
    access_role: entry.accessRole ?? "reader",
    time_zone: entry.timeZone,
  };
}

// ---------------------------------------------------------------------------
// Outgoing shapes
// ---------------------------------------------------------------------------

export type EventWrite = {
  summary: string;
  description?: string;
  location?: string;
  start: number;
  end: number;
  all_day: boolean;
  /** Guest addresses. Google sends the invitations. */
  attendees?: string[];
};

/** The body events.insert / events.patch take, from our own field names. */
export function toGoogleEventBody(input: Partial<EventWrite>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.summary !== undefined) body.summary = input.summary;
  if (input.description !== undefined) body.description = input.description;
  if (input.location !== undefined) body.location = input.location;
  if (input.start !== undefined && input.end !== undefined) {
    if (input.all_day) {
      body.start = { date: utcMidnightToDate(input.start) };
      body.end = { date: utcMidnightToDate(input.end) };
    } else {
      body.start = { dateTime: new Date(input.start).toISOString() };
      body.end = { dateTime: new Date(input.end).toISOString() };
    }
  }
  if (input.attendees !== undefined) {
    body.attendees = input.attendees.map((email) => ({ email }));
  }
  return body;
}

// ---------------------------------------------------------------------------
// REST calls
// ---------------------------------------------------------------------------

async function call<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return await googleCall<T>(accessToken, `${CALENDAR_API}${path}`, { signal: AbortSignal.timeout(30000), ...init }, "Calendar");
}

const enc = encodeURIComponent;

export async function listCalendars(accessToken: string) {
  const out: GoogleCalendarListEntry[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    if (++pages > 20) throw new Error("Calendar list exceeded 20 pages");
    const page = await call<{
      items?: GoogleCalendarListEntry[];
      nextPageToken?: string;
    }>(
      accessToken,
      `/users/me/calendarList${queryString({ minAccessRole: "reader", showHidden: "true", pageToken, maxResults: 250 })}`,
    );
    out.push(...(page.items ?? []));
    if (out.length > 1000) throw new Error("Calendar list exceeds the 1000-calendar sync limit");
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export type EventsPage = {
  items?: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

/**
 * One page of events.list. Either a sync token (incremental — Google forbids
 * the window params alongside it) or a time window (full pass, which ends by
 * handing back the sync token that carries the window forward).
 */
export async function listEvents(
  accessToken: string,
  calendarId: string,
  params: {
    syncToken?: string;
    pageToken?: string;
    timeMin?: string;
    timeMax?: string;
  },
) {
  const query = params.syncToken
    ? { syncToken: params.syncToken, pageToken: params.pageToken, singleEvents: "true", showDeleted: "true", maxResults: 250 }
    : {
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        pageToken: params.pageToken,
        singleEvents: "true",
        showDeleted: "true",
        maxResults: 250,
      };
  return await call<EventsPage>(
    accessToken,
    `/calendars/${enc(calendarId)}/events${queryString(query)}`,
  );
}

export async function insertEvent(
  accessToken: string,
  calendarId: string,
  body: Record<string, unknown>,
) {
  return await call<GoogleEvent>(
    accessToken,
    `/calendars/${enc(calendarId)}/events${queryString({ sendUpdates: "all" })}`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function patchEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  body: Record<string, unknown>,
  etag?: string,
) {
  return await call<GoogleEvent>(
    accessToken,
    `/calendars/${enc(calendarId)}/events/${enc(eventId)}${queryString({ sendUpdates: "all" })}`,
    { method: "PATCH", body: JSON.stringify(body), headers: etag ? { "If-Match": etag } : undefined },
  );
}

export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
) {
  await call<unknown>(
    accessToken,
    `/calendars/${enc(calendarId)}/events/${enc(eventId)}${queryString({ sendUpdates: "all" })}`,
    { method: "DELETE" },
  );
}

export async function getEvent(accessToken: string, calendarId: string, eventId: string) {
  return await call<GoogleEvent>(accessToken, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
}
