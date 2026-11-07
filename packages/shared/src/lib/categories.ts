// The category taxonomy — the one list the classifier, the store, the demo
// fixtures and every surface (rail lanes, chips, sweep view, pickers) share.
// Deliberately small and fixed: eight lanes cover a real inbox, and a fixed
// set is what makes counts, colors and keyboard pickers instant.
//
// "Primary" is the absence of a category: real correspondence stays unmarked.

export type CategoryId =
  | "newsletters"
  | "notifications"
  | "receipts"
  | "travel"
  | "calendar"
  | "promotions"
  | "security"
  | "social";

export type CategoryMeta = {
  id: CategoryId;
  name: string;
  /** One-line meaning, shown in pickers and used verbatim in the classifier
   *  prompt — one definition, no drift between UI and model. */
  hint: string;
  /** Hue (deg) for chips/lanes; saturation/lightness come from the theme. */
  hue: number;
};

export const CATEGORIES: CategoryMeta[] = [
  {
    id: "newsletters",
    name: "Newsletters",
    hint: "Editorial mail you subscribed to — digests, essays, weekly letters",
    hue: 322,
  },
  {
    id: "notifications",
    name: "Notifications",
    hint: "Automated app and service updates — build results, mentions, alerts from tools",
    hue: 210,
  },
  {
    id: "receipts",
    name: "Receipts",
    hint: "Order confirmations, invoices, payments, statements, deliveries",
    hue: 32,
  },
  {
    id: "travel",
    name: "Travel",
    hint: "Itineraries, bookings, check-ins, reservations",
    hue: 174,
  },
  {
    id: "calendar",
    name: "Invitations",
    hint: "Event invitations, RSVPs, schedule changes",
    hue: 258,
  },
  {
    id: "promotions",
    name: "Promotions",
    hint: "Marketing, sales, offers, product announcements you did not ask for",
    hue: 356,
  },
  {
    id: "security",
    name: "Security",
    hint: "Sign-in alerts, verification codes, password and account notices",
    hue: 48,
  },
  {
    id: "social",
    name: "Social",
    hint: "Social network activity — follows, likes, connection requests",
    hue: 138,
  },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as CategoryId[];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function categoryMeta(id: string | undefined): CategoryMeta | null {
  return (id && BY_ID.get(id as CategoryId)) || null;
}

export function isCategoryId(id: unknown): id is CategoryId {
  return typeof id === "string" && BY_ID.has(id as CategoryId);
}
