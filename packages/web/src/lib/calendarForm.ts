import {
  addCalendarDays,
  localDateTime,
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
