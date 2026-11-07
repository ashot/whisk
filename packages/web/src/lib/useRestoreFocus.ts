import { useEffect, useRef } from "react";

export function restoreFocusAfterUnmount(
  target: Pick<HTMLElement, "focus" | "isConnected"> & {
    ownerDocument: Pick<Document, "activeElement" | "body">;
  },
  mounted: { current: boolean },
): void {
  queueMicrotask(() => {
    const doc = target.ownerDocument;
    if (!mounted.current && target.isConnected && doc.activeElement === doc.body) target.focus();
  });
}

/** Hand focus back to whatever held it before this overlay mounted.
 *
 *  Overlays autoFocus their own input, so opening one over the compose box
 *  moves the caret out of it; closing the overlay unmounts that input and
 *  leaves focus on <body>, where keystrokes land nowhere. Capturing at render
 *  (before the overlay's autoFocus commits) and restoring on unmount keeps
 *  typing where the user left it, and never fights the autoFocus. */
export function useRestoreFocus(): void {
  const mounted = useRef(false);
  const previous = useRef<Element | null>(
    typeof document === "undefined" ? null : document.activeElement,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const el = previous.current;
      // A row that scrolled away or a field that unmounted meanwhile is gone —
      // refocusing a detached node would throw the caret into limbo.
      if (el instanceof HTMLElement) restoreFocusAfterUnmount(el, mounted);
    };
  }, []);
}
