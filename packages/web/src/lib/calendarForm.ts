import {
  addCalendarDays,
  localDateTime,
  localDayKey,
  localTimeInput,
  utcDayStamp,
} from "@mail/shared/src/lib/calendar";
import type {
  CalendarEvent,
  CalendarEventInput,
} from "@mail/shared/src/lib/calendarTypes";

export type CalendarFormValues = {
  title: string;
  allDay: boolean;
  startDay: string;
  endDay: string;
  startTime: string;
  endTime: string;
  guests: string;
  location: string;
  notes: string;
};

export function calendarFormSchedule(
  form: CalendarFormValues,
  initial: CalendarFormValues,
  event?: CalendarEvent,
): Pick<CalendarEventInput, "start" | "end" | "all_day"> {
  const modeChanged = form.allDay !== initial.allDay;
  const startChanged =
    modeChanged ||
    form.startDay !== initial.startDay ||
    (!form.allDay && form.startTime !== initial.startTime);
  const endChanged =
    modeChanged ||
    form.endDay !== initial.endDay ||
    (!form.allDay && form.endTime !== initial.endTime);
  return {
    start:
      event && !startChanged
        ? event.start
        : form.allDay
          ? utcDayStamp(form.startDay)
          : localDateTime(form.startDay, form.startTime),
    end:
      event && !endChanged
        ? event.end
        : form.allDay
          ? utcDayStamp(addCalendarDays(form.endDay, 1))
          : localDateTime(form.endDay, form.endTime),
    all_day: event && !modeChanged ? event.all_day : form.allDay,
  };
}

export function calendarEditPatch(
  form: CalendarFormValues,
  initial: CalendarFormValues,
  payload: CalendarEventInput,
): Partial<CalendarEventInput> {
  const patch: Partial<CalendarEventInput> = {};
  if (form.title.trim() !== initial.title.trim())
    patch.summary = payload.summary;
  if (form.location.trim() !== initial.location.trim())
    patch.location = payload.location;
  if (form.notes.trim() !== initial.notes.trim())
    patch.description = payload.description;
  if (form.guests !== initial.guests) patch.attendees = payload.attendees;
  const modeChanged = form.allDay !== initial.allDay;
  if (
    modeChanged ||
    form.startDay !== initial.startDay ||
    (!form.allDay && form.startTime !== initial.startTime)
  )
    patch.start = payload.start;
  if (
    modeChanged ||
    form.endDay !== initial.endDay ||
    (!form.allDay && form.endTime !== initial.endTime)
  )
    patch.end = payload.end;
  if (modeChanged) patch.all_day = payload.all_day;
  return patch;
}

/** How long the form's event lasts: milliseconds when timed, extra days
 *  when all day. NaN while a field is incomplete. */
export function formLength(form: CalendarFormValues): number {
  return form.allDay
    ? Math.round(
        (utcDayStamp(form.endDay) - utcDayStamp(form.startDay)) / 86_400_000,
      )
    : localDateTime(form.endDay, form.endTime) -
        localDateTime(form.startDay, form.startTime);
}

/** Moves the start and carries the end along so the length stays the same,
 *  the way every calendar treats a new start. Typing passes through
 *  incomplete values, so the caller can supply the last length it saw. */
export function moveFormStart<T extends CalendarFormValues>(
  form: T,
  next: Pick<CalendarFormValues, "startDay"> &
    Partial<Pick<CalendarFormValues, "startTime">>,
  length = formLength(form),
): T {
  const moved = { ...form, ...next };
  if (!Number.isFinite(length) || length < 0) return moved;
  if (form.allDay)
    return Number.isFinite(utcDayStamp(moved.startDay))
      ? { ...moved, endDay: addCalendarDays(moved.startDay, length) }
      : moved;
  const start = localDateTime(moved.startDay, moved.startTime);
  if (length === 0 || !Number.isFinite(start)) return moved;
  const end = start + length;
  return { ...moved, endDay: localDayKey(end), endTime: localTimeInput(end) };
}
