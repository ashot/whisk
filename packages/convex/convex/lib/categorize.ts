import {
  CategoryId,
  isCategoryId,
} from "@mail/shared/src/lib/categories";

// The free layers of classification, in confidence order. Everything here is
// deterministic and instant; only what falls through goes to the model. The
// same function classifies real Gmail and the demo fixtures, so the demo is
// an honest preview of the pipeline, not a parallel one.

export type ClassifyInput = {
  fromEmail: string;
  fromName?: string;
  subject: string;
  /** Gmail's own tab labels (CATEGORY_*) when present — a strong free signal. */
  labelIds?: readonly string[];
};

const SECURITY_SUBJECT =
  /verification code|one[- ]?time (code|passcode)|\b2fa\b|security (alert|code|notice)|sign[- ]?in attempt|new (sign[- ]?in|login)|password (reset|changed|expir)|two[- ]factor|confirm your (email|identity)/i;

const CALENDAR_SUBJECT =
  /^(invitation|updated invitation|accepted|declined|tentative|canceled event)[:\s]|calendar|\bRSVP\b/i;

const TRAVEL_SUBJECT =
  /itinerary|boarding pass|check[- ]?in (open|reminder|now)|flight (confirm|receipt|change|delay)|e[- ]?ticket|reservation (confirm|detail)|booking (confirm|reference)|hotel confirm/i;

const RECEIPT_SUBJECT =
  /receipt|invoice|\border\b.*(confirm|#|no\.)|payment (received|confirm|due|failed)|statement (is )?(ready|available)|renewal (notice|receipt)|subscription (renew|confirm)|shipped|out for delivery|delivered:|your delivery|refund/i;

const NEWSLETTER_SUBJECT =
  /newsletter|\bdigest\b|issue\s*(no\.?\s*)?#?\d+|\bvol\.?\s*\d+|weekly (letter|note|roundup)|this week in/i;

const RECEIPT_SENDER =
  /^(billing|receipts?|invoice|invoicing|payments?|statements?|orders?|renewals?|store|shop)[@.+-]/i;

const NOTIFY_SENDER =
  /^(no[- _.]?reply|do[- _.]?not[- _.]?reply|notifications?|notify|alerts?|updates?|automated|mailer|daemon|bot|build|ci|deploy|system)[@.+-]/i;

const NEWSLETTER_SENDER =
  /^(newsletter|news|digest|weekly|dispatch|letters?|post|hello)[@.+-]/i;

const SECURITY_SENDER = /^(security|account[- ]?security|secure|verify)[@.+-]/i;

const NOTIFY_DOMAIN =
  /(^|\.)(github|gitlab|atlassian|circleci|vercel|netlify|sentry|pagerduty|linear|slack|notion|figma|trello|asana|jira)\./i;

const SOCIAL_DOMAIN =
  /(^|\.)(facebook|facebookmail|instagram|twitter|x|linkedin|tiktok|pinterest|reddit|redditmail|strava|nextdoor)\.(com|net)$/i;

/**
 * Classify from structure alone. Returns null when nothing high-precision
 * matches — the caller decides whether that means "primary" or "ask the model".
 */
export function heuristicCategory(input: ClassifyInput): CategoryId | null {
  const email = input.fromEmail.toLowerCase();
  const local = email.split("@")[0] ?? "";
  const domain = email.split("@")[1] ?? "";
  const subject = input.subject;
  const labels = input.labelIds ?? [];

  // Order is precedence: the specific beats the generic, so a security alert
  // from no-reply@accounts.google.com lands in security, not notifications.
  if (SECURITY_SENDER.test(local) || SECURITY_SUBJECT.test(subject)) {
    return "security";
  }
  if (
    domain === "calendar.google.com" ||
    local === "calendar-notification" ||
    CALENDAR_SUBJECT.test(subject)
  ) {
    return "calendar";
  }
  if (TRAVEL_SUBJECT.test(subject)) return "travel";
  if (RECEIPT_SENDER.test(local) || RECEIPT_SUBJECT.test(subject)) {
    return "receipts";
  }
  if (SOCIAL_DOMAIN.test(domain) || labels.includes("CATEGORY_SOCIAL")) {
    return "social";
  }
  if (labels.includes("CATEGORY_PROMOTIONS")) return "promotions";
  if (NEWSLETTER_SENDER.test(local) && NEWSLETTER_SUBJECT.test(subject)) {
    return "newsletters";
  }
  if (NOTIFY_DOMAIN.test(domain) || NOTIFY_SENDER.test(local)) {
    return "notifications";
  }
  if (NEWSLETTER_SUBJECT.test(subject)) return "newsletters";
  return null;
}

/** A model answer is trusted only if it names a real lane; anything else
 *  (hallucinated ids, "primary", prose) means "leave it in primary". */
export function sanitizeCategory(value: unknown): CategoryId | null {
  return isCategoryId(value) ? value : null;
}
