import React, { useEffect, useRef } from "react";
import { mailStore } from "../store/mailStore";
import { useRestoreFocus } from "../lib/useRestoreFocus";

export function useCalendarConfirmationFocus(
  open: boolean,
  returnTo: React.RefObject<HTMLElement | null>,
): void {
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) returnTo.current?.focus();
    wasOpen.current = open;
  }, [open, returnTo]);
}

export function CalendarDialog({
  title,
  onDismiss,
  children,
}: {
  title: string;
  onDismiss: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useRestoreFocus();
  useEffect(() => {
    const dialog = ref.current!;
    mailStore.getState().setCalendarState({ calendarDialogOpen: true });
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>(".calendar-title-input")?.focus();
    return () => {
      dialog.close();
      mailStore.getState().setCalendarState({ calendarDialogOpen: false });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="calendar-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        dismiss.current();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          dismiss.current();
      }}
    >
      {children}
    </dialog>
  );
}

export function CloseIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}
