import { useEffect, type RefObject } from "react";

export type SwipeDir = "left" | "right";

export type SwipeAction = {
  label: string;
  /** The row leaves the list (archive): it slides out instead of back. */
  removes?: boolean;
  run: () => void;
};

/** How far a row travels, as a share of its width, before letting go acts. */
const ARM = 0.32;

/** A row that swipes under a finger. Its parent is the backdrop: it gets
 *  `data-swipe` (the direction), `data-armed` once letting go would act, and
 *  `data-label` for the action's name, all for CSS. Touch only, so a mouse
 *  never drags a row; a vertical move is left to the scroller. */
export function useSwipe(ref: RefObject<HTMLElement | null>, actions: () => Partial<Record<SwipeDir, SwipeAction>>): void {
  useEffect(() => {
    const el = ref.current;
    const slot = el?.parentElement;
    if (!el || !slot) return;
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let axis: "x" | "y" | null = null;
    let armed = false;
    let swiped = false;

    const clear = () => {
      delete slot.dataset.swipe;
      delete slot.dataset.armed;
      delete slot.dataset.label;
    };
    const settle = (to: number, done?: () => void) => {
      el.style.transition = "transform 220ms cubic-bezier(0.32, 0.72, 0, 1)";
      el.style.transform = to ? `translateX(${to}px)` : "";
      window.setTimeout(() => {
        el.style.transition = "";
        if (!to) clear();
        done?.();
      }, 220);
    };

    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      dx = 0;
      axis = null;
      armed = false;
      swiped = false;
      el.style.transition = "";
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      const mx = t.clientX - x0;
      const my = t.clientY - y0;
      if (!axis) {
        if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.2) axis = "x";
        else if (Math.abs(my) > 10) axis = "y";
        else return;
      }
      if (axis !== "x") return;
      const dir: SwipeDir = mx < 0 ? "left" : "right";
      const action = actions()[dir];
      if (!action) return;
      e.preventDefault();
      swiped = true;
      dx = mx;
      el.style.transform = `translateX(${dx}px)`;
      const nowArmed = Math.abs(dx) > el.offsetWidth * ARM;
      if (nowArmed !== armed && nowArmed) navigator.vibrate?.(8);
      armed = nowArmed;
      slot.dataset.swipe = dir;
      slot.dataset.label = action.label;
      if (armed) slot.dataset.armed = "";
      else delete slot.dataset.armed;
    };
    const end = () => {
      if (axis !== "x" || !dx) return;
      const dir: SwipeDir = dx < 0 ? "left" : "right";
      const action = actions()[dir];
      if (!armed || !action) return settle(0);
      if (action.removes) settle(Math.sign(dx) * el.offsetWidth, action.run);
      else {
        action.run();
        settle(0);
      }
    };
    // The tap that ends a swipe is not a tap on the row.
    const click = (e: MouseEvent) => {
      if (swiped) {
        e.stopPropagation();
        e.preventDefault();
        swiped = false;
      }
    };

    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    el.addEventListener("click", click, true);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      el.removeEventListener("click", click, true);
      clear();
    };
  }, [ref, actions]);
}
