export type Calendar = {
  _id: string;
  account_id: string;
  google_id: string;
  summary: string;
  description?: string;
  color?: string;
  foreground?: string;
  primary?: boolean;
  selected?: boolean;
  access_role: string;
  time_zone?: string;
  updated_at: number;
  deleted?: boolean;
};

export type CalendarResponse =
  | "accepted"
  | "tentative"
  | "declined"
  | "needsAction";

export type CalendarEvent = {
  _id: string;
  account_id: string;
  calendar_google_id: string;
  google_id: string;
  client_id?: string;
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
  attendees: Array<{
    email: string;
    name?: string;
    response_status?: string;
    self?: boolean;
    organizer?: boolean;
    optional?: boolean;
  }>;
  organizer?: { email: string; name?: string; self?: boolean };
  my_response?: CalendarResponse;
  recurring_event_id?: string;
  recurring?: boolean;
  pending_outbound?: string;
  write_error?: string;
  updated_at: number;
  deleted?: boolean;
};

export type CalendarPreferences = {
  hiddenCalendars?: string[];
  meetings?: { enabled?: boolean; minutesBefore?: number };
};

export type CalendarEventInput = {
  account_id: string;
  calendar_google_id: string;
  summary: string;
  description?: string;
  location?: string;
  start: number;
  end: number;
  all_day: boolean;
  attendees?: string[];
};
