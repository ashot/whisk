import { seedDemoCalendar } from "./calendar/demo";
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  attachAccountToSession,
  authUserId,
  createAuthSession,
  ensureUserForAccount,
  hashToken,
  requireAccount,
} from "./lib/auth";
import { ensureCluster, placeThreads } from "./clusters";
import { SYSTEM_LABEL_IDS, normalizeLabels, recomputeThread } from "./lib/threads";
import { deleteAccountAndMaybeUser, wipeAccountRowsBatch } from "./lib/accounts";

// A demo mailbox is the app's first-run experience and the surface every
// screenshot and review looks at, so the content here is written, not
// generated. One person's working week: colleagues who reappear, threads that
// answer each other, receipts that match the trip they belong to.
//
// The owner is Nora Adeyemi, who leads product at Driftwork, a six-person
// software company. Everything below is fiction.

type Person = { name: string; email: string };

const ME: Person = { name: "Nora Adeyemi", email: "nora@driftwork.io" };

const PEOPLE = {
  // Driftwork
  theo: { name: "Theo Brandt", email: "theo@driftwork.io" },
  priya: { name: "Priya Raman", email: "priya@driftwork.io" },
  marcus: { name: "Marcus Feld", email: "marcus@driftwork.io" },
  delphine: { name: "Delphine Roy", email: "delphine@driftwork.io" },
  kenji: { name: "Kenji Watanabe", email: "kenji@driftwork.io" },
  // Outside
  hannah: { name: "Hannah Vogel", email: "h.vogel@brightpathsearch.com" },
  alan: { name: "Alan Whitcombe", email: "a.whitcombe@merrowproperty.co.uk" },
  sofia: { name: "Sofía Marín", email: "sofia@estudiomarin.es" },
  yusuf: { name: "Yusuf Adeyemi", email: "yusuf.adeyemi@gmail.com" },
  tess: { name: "Tess Okonkwo", email: "tess@okonkwo.cc" },
  brett: { name: "Brett Sundberg", email: "brett@scalevelocity.io" },
  darius: { name: "Darius Pike", email: "d.pike@quarterlane-capital.com" },
  ines: { name: "Inés Ferreira", email: "ines@interlude.events" },
  gustav: { name: "Gustav Lindqvist", email: "gustav@aperturepodcast.fm" },
  // Machines
  github: { name: "GitHub", email: "notifications@github.com" },
  airline: { name: "Aerial Airways", email: "itinerary@aerialairways.com" },
  hotel: { name: "Casa Alvorada", email: "reservations@casaalvorada.pt" },
  vellum: { name: "Vellum Type Foundry", email: "billing@vellumtype.com" },
  registrar: { name: "Meridian Domains", email: "renewals@meridiandomains.com" },
  payments: { name: "Driftwork Billing", email: "receipts@driftwork.io" },
  accounts: { name: "Google", email: "no-reply@accounts.google.com" },
  calendar: { name: "Google Calendar", email: "calendar-notification@google.com" },
  bank: { name: "Kestrel Bank", email: "statements@kestrelbank.co.uk" },
  dentist: { name: "Marlowe Street Dental", email: "reception@marlowedental.co.uk" },
  library: { name: "Hackney Libraries", email: "holds@hackneylibraries.gov.uk" },
  allotment: { name: "Fen Road Allotments", email: "committee@fenroadallotments.org" },
  overcast: { name: "The Overcast", email: "dispatch@overcastweekly.com" },
  kernel: { name: "Kernel Panic", email: "hello@kernelpanic.email" },
  marginalia: { name: "Marginalia", email: "letters@marginalia.press" },
  slowsoftware: { name: "Slow Software", email: "post@slowsoftware.club" },
  mailapp: { name: "Mail", email: "hello@mail.app" },
  deals: { name: "Loomly Deals", email: "offers@loomly-deals.com" },
  parcel: { name: "Parcel Notice", email: "delivery@pcl-notice-track.info" },
  lottery: { name: "Global Awards Board", email: "claims@globalawards-board.net" },
  verify: { name: "Account Services", email: "secure@account-verify-now.co" },
} satisfies Record<string, Person>;

type SeedAttachment = {
  filename: string;
  mime_type: string;
  size: number;
};

type SeedMessage = {
  /** A key from PEOPLE, or "me" for the mailbox owner. */
  from: keyof typeof PEOPLE | "me";
  to?: Array<keyof typeof PEOPLE | "me">;
  cc?: Array<keyof typeof PEOPLE | "me">;
  /** Minutes after the thread's start time. */
  at: number;
  text: string;
  html?: string;
  attachments?: SeedAttachment[];
};

type SeedThread = {
  subject: string;
  /** Days before seed time that the thread started. */
  daysAgo: number;
  /** Labels beyond the ones derived from placement. */
  labels?: string[];
  placement?: "inbox" | "archive" | "sent" | "trash" | "spam";
  unread?: boolean;
  starred?: boolean;
  messages: SeedMessage[];
};

const L = SYSTEM_LABEL_IDS;

// Which lane each machine sender's mail files under. The demo is seeded
// pre-classified — the first-run inbox shows the lanes working, not a pile
// waiting for a model. Humans are absent on purpose: their mail is primary.
const DEMO_CATEGORIES: Partial<Record<keyof typeof PEOPLE, string>> = {
  github: "notifications",
  airline: "travel",
  hotel: "travel",
  vellum: "receipts",
  registrar: "receipts",
  payments: "receipts",
  bank: "receipts",
  accounts: "security",
  calendar: "calendar",
  overcast: "newsletters",
  kernel: "newsletters",
  marginalia: "newsletters",
  slowsoftware: "newsletters",
  deals: "promotions",
  mailapp: "notifications",
  dentist: "notifications",
  library: "notifications",
  allotment: "notifications",
};

// What Whisk "knows" on first run — the memory view starts honest and lived-in.
// Style entries match how Nora's seeded sent mail actually reads.
const DEMO_MEMORIES: Array<{
  kind: "style" | "contact" | "rule" | "preference";
  text: string;
  contact_email?: string;
  category?: string;
  source: "correction" | "sent" | "manual";
}> = [
  {
    kind: "style",
    text: "Opens with the first name and no greeting word — 'Theo,' not 'Hi Theo'",
    source: "sent",
  },
  {
    kind: "style",
    text: "Short paragraphs, rarely more than three sentences each; asks one clear question at a time",
    source: "sent",
  },
  {
    kind: "style",
    text: "Signs off with just 'Nora', no closing phrase",
    source: "sent",
  },
  {
    kind: "contact",
    text: "Theo is Driftwork's co-founder — no formality needed, decisions can be made directly",
    contact_email: "theo@driftwork.io",
    source: "manual",
  },
  {
    kind: "contact",
    text: "Hannah is an outside recruiter — friendly but non-committal until a role is actually interesting",
    contact_email: "h.vogel@brightpathsearch.com",
    source: "manual",
  },
  {
    kind: "rule",
    text: "Mail from dispatch@overcastweekly.com files under Newsletters",
    contact_email: "dispatch@overcastweekly.com",
    category: "newsletters",
    source: "correction",
  },
  {
    kind: "preference",
    text: "Keep replies to cold outreach short and polite; never commit to a call in the first reply",
    source: "manual",
  },
];

const USER_LABELS = [
  { gmail_id: "Label_Receipts", name: "Receipts", color: "#c07a2c" },
  { gmail_id: "Label_Travel", name: "Travel", color: "#2f7d76" },
  { gmail_id: "Label_Newsletters", name: "Newsletters", color: "#8c5a7d" },
];

const SYSTEM_LABELS = [
  { gmail_id: L.INBOX, name: "Inbox" },
  { gmail_id: L.STARRED, name: "Starred" },
  { gmail_id: L.SENT, name: "Sent" },
  { gmail_id: L.DRAFT, name: "Drafts" },
  { gmail_id: L.TRASH, name: "Trash" },
  { gmail_id: L.SPAM, name: "Spam" },
  { gmail_id: L.UNREAD, name: "Unread" },
];

// ---------------------------------------------------------------------------
// HTML bodies. Restrained on purpose: system fonts, one accent, no images, no
// tracking pixels — the kind of mail that reads well in a serif reader.
// ---------------------------------------------------------------------------

const shell = (accent: string, inner: string) => `<div style="font:16px/1.65 Georgia,'Iowan Old Style',serif;color:#211d1a;max-width:34em;margin:0 auto;padding:8px 0">${inner}<hr style="border:none;border-top:1px solid #e3ddd4;margin:28px 0 14px"><p style="font:12px/1.6 -apple-system,system-ui,sans-serif;color:#8a8177">You are receiving this because you subscribed. <a href="https://example.com/unsubscribe" style="color:${accent}">Unsubscribe</a>.</p></div>`;

const OVERCAST_HTML = shell(
  "#8c5a7d",
  `<p style="font:11px/1 -apple-system,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#8c5a7d;margin:0 0 6px">The Overcast · No. 214</p>
<h1 style="font:600 26px/1.25 Georgia,serif;margin:0 0 18px">The interface that admits it is guessing</h1>
<p style="margin:0 0 16px">Every product that predicts something eventually has to decide how loudly to say so. The pattern I keep seeing this year is quiet confidence: the guess is applied, and the undo is one key away. That is a very different posture from the modal that asks you to confirm what the machine already believes.</p>
<p style="margin:0 0 16px">Gmail's <em>undo send</em> is the ur-example. Nobody reads the toast. Everybody knows it is there. The affordance does its work by existing.</p>
<h2 style="font:600 17px/1.3 Georgia,serif;margin:26px 0 10px">Three things worth your Tuesday</h2>
<ol style="margin:0 0 16px;padding-left:1.2em">
<li style="margin-bottom:8px"><a href="https://example.com/a" style="color:#8c5a7d">A field guide to keyboard-first apps</a> — a careful survey of what people actually memorise, and why it is never more than nine keys.</li>
<li style="margin-bottom:8px"><a href="https://example.com/b" style="color:#8c5a7d">Against the three-pane layout</a> — a stubborn, convincing argument that reading and scanning want different rooms.</li>
<li><a href="https://example.com/c" style="color:#8c5a7d">On latency budgets</a> — the numbers behind "feels instant", with a good section on why 100ms is the wrong target for local work.</li>
</ol>
<p style="margin:0 0 16px">Next week: an interview with the team that rewrote their sync engine twice and would do it again.</p>
<p style="margin:0">— Wren</p>`,
);

const KERNEL_HTML = shell(
  "#2f7d76",
  `<p style="font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;color:#2f7d76;margin:0 0 6px">KERNEL PANIC · ISSUE 88</p>
<h1 style="font:600 25px/1.25 Georgia,serif;margin:0 0 18px">Your database is not the bottleneck, your fan-out is</h1>
<p style="margin:0 0 16px">A reader sent in a trace last week that explained a whole class of "the app got slow after we grew" reports. The queries were all under 4ms. There were just nine hundred of them per request, issued one at a time because the ORM made that the path of least resistance.</p>
<pre style="background:#f5f1ea;border:1px solid #e3ddd4;border-radius:6px;padding:12px 14px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:auto;margin:0 0 16px">for (const id of ids) {
  rows.push(await db.get(id))   // 900 round trips
}</pre>
<p style="margin:0 0 16px">The fix is boring and it is always the same: hoist the loop into the query, or batch the ids. What is interesting is why it keeps happening — the slow version reads better, and nothing in the local development loop punishes it.</p>
<p style="margin:0 0 16px"><strong>Also this week:</strong> a readable postmortem of a 40-minute outage caused by a retry storm, and a small tool that graphs query counts per endpoint in CI so the regression shows up in the pull request instead of in production.</p>
<p style="margin:0">— Deb</p>`,
);

const MARGINALIA_HTML = shell(
  "#c07a2c",
  `<p style="font:11px/1 -apple-system,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#c07a2c;margin:0 0 6px">Marginalia · Saturday letter</p>
<h1 style="font:600 26px/1.25 Georgia,serif;margin:0 0 18px">Notes on rereading</h1>
<p style="margin:0 0 16px">There is a particular pleasure in a second reading, when the plot no longer needs your attention and the sentences finally get it. I spent the week with a book I first read at nineteen and found a completely different one underneath.</p>
<blockquote style="margin:0 0 16px;padding:2px 0 2px 16px;border-left:3px solid #e3ddd4;color:#4a443d;font-style:italic">"We do not read the same book twice, because we are not the same reader twice."</blockquote>
<p style="margin:0 0 16px">Three short reviews below, and a reader's list of books that are better the second time. As ever, replies are read by a person.</p>
<p style="margin:0">— Cordelia</p>`,
);

const SLOW_HTML = shell(
  "#2f7d76",
  `<p style="font:11px/1 -apple-system,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#2f7d76;margin:0 0 6px">Slow Software · Monthly</p>
<h1 style="font:600 25px/1.25 Georgia,serif;margin:0 0 18px">Software that outlives its funding</h1>
<p style="margin:0 0 16px">This month's theme is durability. Not uptime — durability. What does it take for a tool to still work in twelve years, after the company is gone, after the API keys expire, after the format everyone agreed on is no longer fashionable?</p>
<p style="margin:0 0 16px">The answers our contributors keep landing on: own your data on disk, prefer boring formats, and make the export the same code path as the backup. Everything else is decoration.</p>
<p style="margin:0 0 16px">Members' call is on the 12th. Bring one piece of software you still use that is older than ten years, and be ready to say why it survived.</p>
<p style="margin:0">— the editors</p>`,
);

const FLIGHT_HTML = `<div style="font:15px/1.6 -apple-system,system-ui,'Helvetica Neue',sans-serif;color:#1d1b19;max-width:36em">
<p style="font:11px/1 -apple-system,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#8a8177;margin:0 0 6px">Aerial Airways · Booking confirmed</p>
<h1 style="font:600 22px/1.3 -apple-system,system-ui,sans-serif;margin:0 0 4px">London → Lisbon</h1>
<p style="color:#6b635a;margin:0 0 20px">Reference <strong style="color:#1d1b19;letter-spacing:.06em">QK7T2M</strong></p>
<table style="width:100%;border-collapse:collapse;font-size:14px">
<tr><td style="padding:10px 0;border-top:1px solid #e6e1da;color:#6b635a">Outbound</td><td style="padding:10px 0;border-top:1px solid #e6e1da;text-align:right">AE 442 · LGW 07:15 → LIS 09:55</td></tr>
<tr><td style="padding:10px 0;border-top:1px solid #e6e1da;color:#6b635a">Return</td><td style="padding:10px 0;border-top:1px solid #e6e1da;text-align:right">AE 447 · LIS 18:40 → LGW 21:25</td></tr>
<tr><td style="padding:10px 0;border-top:1px solid #e6e1da;color:#6b635a">Passenger</td><td style="padding:10px 0;border-top:1px solid #e6e1da;text-align:right">ADEYEMI / NORA</td></tr>
<tr><td style="padding:10px 0;border-top:1px solid #e6e1da;color:#6b635a">Seat</td><td style="padding:10px 0;border-top:1px solid #e6e1da;text-align:right">14A (window), 22C on return</td></tr>
<tr><td style="padding:10px 0;border-top:1px solid #e6e1da;border-bottom:1px solid #e6e1da;color:#6b635a">Total paid</td><td style="padding:10px 0;border-top:1px solid #e6e1da;border-bottom:1px solid #e6e1da;text-align:right"><strong>£214.60</strong></td></tr>
</table>
<p style="margin:20px 0 0;color:#6b635a;font-size:13px">Check-in opens 24 hours before departure. One cabin bag and one personal item are included.</p>
</div>`;

const INVOICE_HTML = `<div style="font:15px/1.6 -apple-system,system-ui,'Helvetica Neue',sans-serif;color:#1d1b19;max-width:34em">
<h1 style="font:600 20px/1.3 -apple-system,system-ui,sans-serif;margin:0 0 2px">Invoice 2291</h1>
<p style="color:#6b635a;margin:0 0 20px">Vellum Type Foundry · due in 14 days</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">
<tr><td style="padding:9px 0;border-top:1px solid #e6e1da">Sablon Text — 5 seat desktop licence</td><td style="padding:9px 0;border-top:1px solid #e6e1da;text-align:right">£420.00</td></tr>
<tr><td style="padding:9px 0;border-top:1px solid #e6e1da">Sablon Text — web licence, 250k views/mo</td><td style="padding:9px 0;border-top:1px solid #e6e1da;text-align:right">£180.00</td></tr>
<tr><td style="padding:9px 0;border-top:1px solid #e6e1da;color:#6b635a">VAT (20%)</td><td style="padding:9px 0;border-top:1px solid #e6e1da;text-align:right;color:#6b635a">£120.00</td></tr>
<tr><td style="padding:11px 0;border-top:2px solid #1d1b19;border-bottom:1px solid #e6e1da"><strong>Total</strong></td><td style="padding:11px 0;border-top:2px solid #1d1b19;border-bottom:1px solid #e6e1da;text-align:right"><strong>£720.00</strong></td></tr>
</table>
<p style="margin:20px 0 0;color:#6b635a;font-size:13px">The full licence agreement is attached. Reply to this address with any billing questions — a person reads it.</p>
</div>`;

const SECURITY_HTML = `<div style="font:15px/1.6 -apple-system,system-ui,'Helvetica Neue',sans-serif;color:#1d1b19;max-width:34em">
<h1 style="font:600 19px/1.35 -apple-system,system-ui,sans-serif;margin:0 0 12px">New sign-in on a Mac</h1>
<p style="margin:0 0 14px">Your account <strong>nora@driftwork.io</strong> was signed in to on a new device.</p>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 16px">
<tr><td style="padding:8px 0;border-top:1px solid #e6e1da;color:#6b635a">Device</td><td style="padding:8px 0;border-top:1px solid #e6e1da;text-align:right">MacBook Pro · Safari</td></tr>
<tr><td style="padding:8px 0;border-top:1px solid #e6e1da;color:#6b635a">Where</td><td style="padding:8px 0;border-top:1px solid #e6e1da;text-align:right">Porto, Portugal</td></tr>
<tr><td style="padding:8px 0;border-top:1px solid #e6e1da;border-bottom:1px solid #e6e1da;color:#6b635a">When</td><td style="padding:8px 0;border-top:1px solid #e6e1da;border-bottom:1px solid #e6e1da;text-align:right">Today, 08:14</td></tr>
</table>
<p style="margin:0;color:#6b635a;font-size:13px">If this was you, no action is needed. If it was not, change your password and sign out of all sessions.</p>
</div>`;

const WELCOME_HTML = `<div style="font:17px/1.7 Georgia,'Iowan Old Style',serif;color:#211d1a;max-width:32em">
<p style="font:11px/1 -apple-system,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#a8562f;margin:0 0 10px">Start here</p>
<h1 style="font:600 27px/1.25 Georgia,serif;margin:0 0 18px">Nine keys and you can put the mouse down</h1>
<p style="margin:0 0 16px">This is a demo mailbox: every message in it is fiction, and nothing you do here leaves your machine. Break things freely.</p>
<p style="margin:0 0 10px">The whole app is built around a handful of keys:</p>
<table style="border-collapse:collapse;font:14px/1.6 -apple-system,system-ui,sans-serif;margin:0 0 18px">
<tr><td style="padding:5px 14px 5px 0"><code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">j</code> <code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">k</code></td><td style="padding:5px 0;color:#4a443d">move down and up the list</td></tr>
<tr><td style="padding:5px 14px 5px 0"><code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">Enter</code></td><td style="padding:5px 0;color:#4a443d">open the thread, <code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">Esc</code> to come back</td></tr>
<tr><td style="padding:5px 14px 5px 0"><code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">e</code></td><td style="padding:5px 0;color:#4a443d">archive — <code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">u</code> undoes it</td></tr>
<tr><td style="padding:5px 14px 5px 0"><code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">#</code></td><td style="padding:5px 0;color:#4a443d">move to trash</td></tr>
<tr><td style="padding:5px 14px 5px 0"><code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">s</code></td><td style="padding:5px 0;color:#4a443d">star</td></tr>
<tr><td style="padding:5px 14px 5px 0"><code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">c</code></td><td style="padding:5px 0;color:#4a443d">compose, <code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">r</code> replies</td></tr>
<tr><td style="padding:5px 14px 5px 0"><code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">/</code></td><td style="padding:5px 0;color:#4a443d">search</td></tr>
</table>
<p style="margin:0 0 16px">Press <code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">?</code> at any time for the full sheet, and <code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">g</code> then <code style="font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2ede5;border:1px solid #e0d9cf;border-radius:4px;padding:2px 7px">i</code> to come home to the inbox.</p>
<p style="margin:0;color:#6b635a">Connect a real mailbox whenever you are ready — the demo stays where it is.</p>
</div>`;

const GITHUB_STYLE = `font:15px/1.6 -apple-system,system-ui,'Helvetica Neue',sans-serif;color:#1d1b19;max-width:34em`;

// ---------------------------------------------------------------------------
// The mailbox
// ---------------------------------------------------------------------------

const THREADS: SeedThread[] = [
  {
    subject: "Nine keys and you can put the mouse down",
    // Newest in the mailbox on purpose: the tour is the first row you see.
    daysAgo: 0.02,
    starred: true,
    unread: true,
    messages: [
      {
        from: "mailapp",
        to: ["me"],
        at: 0,
        html: WELCOME_HTML,
        text: "This is a demo mailbox. j and k move, Enter opens, Esc goes back, e archives, # trashes, s stars, c composes, r replies, / searches. Press ? for the full sheet.",
      },
    ],
  },

  {
    subject: "Composer v3: do we ship it without offline?",
    daysAgo: 1.1,
    unread: true,
    messages: [
      {
        from: "theo",
        to: ["me", "priya", "marcus", "kenji"],
        at: 0,
        text: `Putting a stake in the ground because we have been circling this for two weeks.

The composer rewrite is done except for offline queueing. Offline is roughly another eight working days: the outbox, the conflict rules for a draft edited in two tabs, and the retry policy. Everything else — the new recipient field, attachments, the send animation — is behind the flag and green.

I want to ship what we have on Thursday and follow with offline in the next release. Two reasons. First, the current composer loses attachments on retry, which is a live bug we are shipping around today. Second, every week the flag stays on is a week both code paths have to keep working.

Push back if you think that is wrong.`,
      },
      {
        from: "priya",
        to: ["theo", "me", "marcus", "kenji"],
        at: 47,
        text: `I think it is wrong, but not for the reason you expect.

The offline part I can live without. What I cannot live with is the half-state we would ship: send fails, the draft stays in the composer, and there is no indication anything went wrong other than the message not appearing in Sent. That is worse than the attachment bug because it fails silently.

Give me a failed-send state in the composer — a line of text and a retry button — and I will happily ship Thursday.`,
      },
      {
        from: "kenji",
        to: ["priya", "theo", "me", "marcus"],
        at: 96,
        text: `Numbers, for whatever they are worth.

Sends that fail and never get retried: 0.4% of all sends last month. Of those, 71% were on mobile connections. The attachment-drop bug hit 1.9% of sends with attachments, which is 0.3% of all sends.

So the two are about the same size. Priya's failed-send state would cover both, which makes it the higher-leverage piece of work.`,
      },
      {
        from: "marcus",
        to: ["kenji", "priya", "theo", "me"],
        at: 143,
        text: `I care about one thing: does the person who hit send know whether it sent?

If the answer is no, we do not ship, offline or not. Theo, how long is Priya's version?`,
      },
      {
        from: "theo",
        to: ["marcus", "kenji", "priya", "me"],
        at: 168,
        text: `A day and a half, maybe two. The composer already knows the send failed; it just does nothing with it. The work is the design and making retry idempotent so a double-tap does not send twice.

Which I should do anyway for the offline work, so it is not wasted.`,
      },
      {
        from: "me",
        to: ["theo", "marcus", "kenji", "priya"],
        at: 190,
        text: `Then that is the plan: failed-send state now, ship Thursday, offline in the next release.

Theo — make retry idempotent on the client id, not on the message content. Two identical messages sent on purpose is a real thing people do and we should not swallow the second one.

Priya, can you get Theo the state by tomorrow lunchtime? A line of text, an icon, and a retry affordance is enough. We are not designing an error taxonomy.`,
      },
      {
        from: "priya",
        to: ["me", "theo", "marcus", "kenji"],
        at: 214,
        text: `Yes. I will do the failed state and the queued state at the same time, since offline will need the second one and it is the same component.`,
      },
      {
        from: "theo",
        to: ["priya", "me", "marcus", "kenji"],
        at: 1490,
        text: `Idempotent retry is in and the flag is on for the team. Please break it.

One thing worth knowing: a retry now reuses the client id, so if you send, kill your connection, and send again, you will get one message and not two. If you actually want two, change a character.`,
      },
    ],
  },

  {
    subject: "Senior product engineer — two candidates worth your Thursday",
    daysAgo: 2.4,
    messages: [
      {
        from: "hannah",
        to: ["me"],
        at: 0,
        text: `Nora — two people I would like you to meet, both of whom I have worked with before and would vouch for.

The first is a systems engineer who spent four years on a sync engine at a note-taking company. She is the person you want if the offline story is going to be real. She is interviewing at two other places and has told me she would prefer a small team.

The second is less obvious: a frontend engineer with an unusual amount of taste, currently at an agency and bored. Weaker on distributed systems, much stronger on the parts of your product people actually touch.

I have 45-minute slots on Thursday for either or both. Shall I book?`,
      },
      {
        from: "me",
        to: ["hannah"],
        at: 82,
        text: `Both, please. Thursday afternoon if there is anything after 2pm — mornings are standups and I am useless in them.

One thing: for the second candidate, can you find out what "bored" means? Bored by the work or bored by the clients. Those are different people and only one of them is happy here.`,
      },
      {
        from: "hannah",
        to: ["me"],
        at: 156,
        text: `Booked: 2:00pm and 3:15pm Thursday, calendar invites to follow.

On "bored" — I asked. It is the clients. Her words: "I have built the same marketing site eleven times and I would like to build one thing for four years." I thought you would like that.`,
      },
      {
        from: "me",
        to: ["hannah"],
        at: 171,
        text: `That is the right answer. See you Thursday.`,
      },
      {
        from: "hannah",
        to: ["me"],
        at: 1580,
        text: `Both candidates confirmed and have the brief. I have asked them to come with questions rather than a portfolio walkthrough — you get more out of the second half hour that way.`,
      },
    ],
  },

  {
    subject: "Postgres 16 upgrade — Sunday 03:00 UTC",
    daysAgo: 3.2,
    messages: [
      {
        from: "theo",
        to: ["me", "marcus", "kenji", "delphine"],
        at: 0,
        text: `Doing the Postgres 16 upgrade this Sunday at 03:00 UTC. Expect up to twelve minutes where writes fail and reads are served from the replica.

I have run the whole thing twice against a restored snapshot. The only surprise was that our oldest full-text index has to be rebuilt, which is the twelve minutes.

Delphine — worth a line in the status page an hour before. Nothing dramatic, people mostly want to know it is intentional.`,
      },
      {
        from: "delphine",
        to: ["theo", "me", "marcus", "kenji"],
        at: 38,
        text: `Status page scheduled for 02:00 UTC and I will be around from 02:45 in case anything reaches support. I will keep the wording to "planned maintenance, up to fifteen minutes" — better to overstate and finish early.`,
      },
    ],
  },

  {
    subject: "Type scale v3 — one size fewer",
    daysAgo: 4.1,
    messages: [
      {
        from: "priya",
        to: ["me"],
        at: 0,
        text: `New type scale is in Figma. The short version: I removed a size.

We had seven and used four. The two in the middle were doing the same job in different places, which is how you end up with a settings page that looks like a different product. Six now, and the ratio is slightly tighter so long body text sets better at the reading width.

The thread view is the thing to look at. Reading measure is 68 characters and the body is a proper text serif rather than the UI face. It is a noticeably nicer thing to read for ten minutes.`,
      },
      {
        from: "me",
        to: ["priya"],
        at: 121,
        text: `Looked. The thread view is a real improvement — the first time our own product has felt like a place to read rather than a place to process.

One note: the metadata line above the body is now quite far from the body it belongs to. It reads as a header for the whole thread rather than for that message. Tighten it by a step?`,
      },
      {
        from: "priya",
        to: ["me"],
        at: 154,
        text: `Agreed, that is a mistake. Tightened, and I gave the collapsed message rows a bit more air to compensate. Pushed.`,
      },
    ],
  },

  {
    subject: "Board deck — I need your two slides by Thursday",
    daysAgo: 2.9,
    messages: [
      {
        from: "marcus",
        to: ["me"],
        at: 0,
        text: `Board is on the 19th. I need two slides from you by Thursday end of day.

Slide one: what shipped last quarter and what it did to the numbers. Please be honest about the things that did not move anything — they will ask, and it goes much better when we raise it first.

Slide two: the next two quarters, with the offline work on it. Darius will ask how it affects the enterprise conversations, so have an answer ready even if it is not on the slide.`,
      },
      {
        from: "me",
        to: ["marcus"],
        at: 210,
        text: `Thursday works. On Darius's question, the honest answer is that offline unblocks two of the four deals in the pipeline and is irrelevant to the other two, which are both stuck on SSO. I would rather say that plainly than imply offline is the whole story.`,
      },
      {
        from: "marcus",
        to: ["me"],
        at: 246,
        text: `Say it plainly. He respects that more than the alternative, and he will find out anyway.`,
      },
    ],
  },

  {
    subject: "Support digest — week 32",
    daysAgo: 1.6,
    unread: true,
    messages: [
      {
        from: "delphine",
        to: ["me", "marcus", "theo"],
        at: 0,
        text: `88 conversations, median first reply 41 minutes, three unhappy.

The three: one attachment lost on send (the known bug, apologised and re-sent for them), one person who cannot find archived mail because we do not have an All Mail view yet, and one genuinely angry customer whose SSO trial expired before we replied to their setup question. That last one is on me and I have called them.

The recurring theme this week is search. Eleven people asked some version of "how do I find a message from a specific person". We have the feature. Nobody can find it. That is a discovery problem, not a search problem.

Full export attached if you want to read the three yourself.`,
        attachments: [
          {
            filename: "support-week-32.csv",
            mime_type: "text/csv",
            size: 24_618,
          },
        ],
      },
    ],
  },

  {
    subject: "Weekly numbers — activation up 4.1 points",
    daysAgo: 5.3,
    messages: [
      {
        from: "kenji",
        to: ["me", "marcus", "theo", "priya", "delphine"],
        at: 0,
        text: `Activation for the week: 38.7%, up 4.1 points on last week and the highest we have recorded.

Before anyone celebrates: 2.6 of those points are the onboarding change, and about 1.5 is a cohort effect from the conference traffic, which is unusually well qualified and will not repeat. Call it a real 2.6.

Retention at week four is flat at 61%, which is the number I would like us to be talking about in the board meeting rather than activation.`,
      },
      {
        from: "marcus",
        to: ["kenji", "me", "theo", "priya", "delphine"],
        at: 55,
        text: `Noted, and agreed on which number matters. Kenji, can you get me a week-four retention chart split by whether the account connected a second device? I have a hunch and I would like to be wrong about it in private.`,
      },
    ],
  },

  {
    subject: "Postmortem: 22 minutes of failed sign-ins",
    daysAgo: 7.4,
    messages: [
      {
        from: "theo",
        to: ["me", "marcus", "delphine", "kenji"],
        at: 0,
        text: `Postmortem for Tuesday. Short version: we ran out of database connections because a deploy doubled the pool size per instance while the instance count was also doubling for the traffic spike.

Timeline. 14:02 deploy goes out. 14:09 first sign-in failures, roughly one in twenty. 14:15 alert fires. 14:21 I find the connection count pinned at the limit. 14:24 rollback starts. 14:31 fully recovered.

What made it slow: the alert threshold was on error rate across all endpoints, and sign-in is a small fraction of traffic, so one in twenty sign-ins failing barely moved it. The alert we needed was on the connection pool, which we did not have.

Three actions. Alert on pool saturation at 80%, which I have already added. Pin the pool size to a total rather than per-instance. And add sign-in as its own error-rate alert, because it is the one endpoint where a single failure is a lost user rather than a retry.`,
      },
      {
        from: "delphine",
        to: ["theo", "me", "marcus", "kenji"],
        at: 92,
        text: `From the support side: nine people wrote in during those 22 minutes and four of them had already given up and emailed rather than retried. Worth knowing that a sign-in failure does not produce a retry, it produces a person who thinks the product is broken.`,
      },
      {
        from: "me",
        to: ["delphine", "theo", "marcus", "kenji"],
        at: 130,
        text: `Good postmortem — thank you for writing it the same week rather than the same month.

The point about sign-in failures not producing retries is the thing I want us to remember. Theo, when you do the per-endpoint alerting, treat sign-in and send as the two that page someone.`,
      },
    ],
  },

  {
    subject: "Empty states — can you look before I go further?",
    daysAgo: 6.2,
    messages: [
      {
        from: "priya",
        to: ["me"],
        at: 0,
        text: `Six empty states drawn: inbox zero, no search results, empty trash, empty spam, no drafts, and the first-run state before a mailbox is connected.

The one I am unsure about is inbox zero. Everything I draw is either smug or twee, and I have started to wonder whether the right answer is almost nothing — the date, and a single line. Look at the third variant and tell me if it feels bare or calm.`,
      },
      {
        from: "me",
        to: ["priya"],
        at: 66,
        text: `Third variant. It is calm, and the reason the others feel twee is that they are congratulating the person for something ordinary.

One change: put the count of what you archived today under it. "You archived 34 messages" is a fact rather than a compliment, and it is the thing someone at inbox zero is quietly pleased about anyway.`,
      },
    ],
  },

  {
    subject: "Lunch Thursday with the Halberd people?",
    daysAgo: 4.6,
    messages: [
      {
        from: "marcus",
        to: ["me"],
        at: 0,
        text: `Halberd are in town Thursday and have asked for lunch. I think it is a partnership conversation but it might be an acquisition conversation wearing a partnership hat.

Come if you can. If it turns into the second thing I would rather have someone in the room who can talk about the product without me.`,
      },
      {
        from: "me",
        to: ["marcus"],
        at: 34,
        text: `Thursday is candidate interviews at 2 and 3:15. If lunch ends by 1:30 I am in.`,
      },
    ],
  },

  {
    subject: "SSO timeline — what can I tell Corriedale?",
    daysAgo: 3.8,
    unread: true,
    messages: [
      {
        from: "delphine",
        to: ["me", "theo"],
        at: 0,
        text: `Corriedale have asked for the third time about SAML. They are 140 seats and their security review is blocked on it.

I have been saying "later this year" since April, which is now doing damage — the person I deal with there told me she has stopped bringing it to her team because she does not believe the answer.

I do not need a date. I need something true I can say.`,
      },
      {
        from: "theo",
        to: ["delphine", "me"],
        at: 71,
        text: `Something true: SAML is not being worked on and will not start before the offline work finishes. That is at least six weeks out, and then it is three to four weeks of work.

I would rather she heard "not before November, and we will tell you the week it starts" than another "later this year".`,
      },
    ],
  },

  {
    subject: "Retention chart — the query, and a caveat",
    daysAgo: 5.9,
    messages: [
      {
        from: "kenji",
        to: ["marcus", "me"],
        at: 0,
        text: `Chart is in the shared folder. Marcus, your hunch was right and also misleading.

Accounts that connect a second device retain at 74% at week four. Accounts that do not retain at 52%. That is a big gap and it is tempting to conclude that we should push people to connect a second device.

The caveat: connecting a second device is mostly a symptom, not a cause. People who have decided to use the product connect their laptop. I checked the ordering and in three quarters of cases the second device comes after the behaviour that predicts retention, not before.

I would treat it as a good signal for predicting churn and a bad target for driving it.`,
      },
      {
        from: "marcus",
        to: ["kenji", "me"],
        at: 40,
        text: `This is exactly why I asked in private. Thank you for the caveat — I would have put the wrong thing on a slide.`,
      },
    ],
  },

  {
    subject: "Offsite — Porto, 14–16 October",
    daysAgo: 8.7,
    messages: [
      {
        from: "delphine",
        to: ["me", "marcus", "theo", "priya", "kenji"],
        at: 0,
        text: `Porto is booked: 14 to 16 October, a house in Foz with a room big enough to work in, and flights are on everyone's calendar.

I have deliberately left the afternoons empty. The last two offsites were scheduled to the minute and the useful conversations all happened at dinner, so this time dinner is the schedule.

Dietary requirements and anything you need to make the travel work — reply here by Friday.`,
      },
      {
        from: "priya",
        to: ["delphine", "me", "marcus", "theo", "kenji"],
        at: 88,
        text: `Vegetarian, and I would like to arrive a day early at my own cost if the house is free on the 13th.`,
      },
      {
        from: "theo",
        to: ["delphine", "priya", "me", "marcus", "kenji"],
        at: 121,
        text: `No requirements. Strong opinion that we do not do a retrospective on the first morning while everyone is still tired from travelling.`,
      },
    ],
  },

  {
    subject: "Your trip to Lisbon is confirmed — QK7T2M",
    daysAgo: 9.4,
    labels: ["Label_Travel", "Label_Receipts"],
    messages: [
      {
        from: "airline",
        to: ["me"],
        at: 0,
        html: FLIGHT_HTML,
        text: "Aerial Airways booking QK7T2M confirmed. Outbound AE 442, LGW 07:15 to LIS 09:55. Return AE 447, LIS 18:40 to LGW 21:25. Passenger ADEYEMI/NORA. Seat 14A outbound, 22C return. Total paid £214.60.",
      },
    ],
  },

  {
    subject: "Check in now for AE 442 to Lisbon",
    daysAgo: 0.9,
    labels: ["Label_Travel"],
    unread: true,
    messages: [
      {
        from: "airline",
        to: ["me"],
        at: 0,
        text: `Check-in is open for AE 442, London Gatwick to Lisbon, departing tomorrow at 07:15.

Booking reference QK7T2M. Bag drop closes at 06:15 and the gate closes at 06:55.

You are in seat 14A. Check in online to get your boarding pass on your phone.`,
      },
    ],
  },

  {
    subject: "Casa Alvorada — reservation confirmed, 13–16 October",
    daysAgo: 9.1,
    labels: ["Label_Travel", "Label_Receipts"],
    messages: [
      {
        from: "hotel",
        to: ["me"],
        at: 0,
        text: `Dear Ms Adeyemi,

Your reservation at Casa Alvorada is confirmed for three nights, 13 to 16 October, in the corner room on the second floor. Breakfast is included and is served until 10:30.

Check-in is from 15:00. If you arrive earlier we are happy to keep your bags. The gate code is sent by message on the morning of arrival.

Total: €420, paid. We look forward to having you.

Beatriz
Casa Alvorada, Rua de Fonte Nova 22, Porto`,
      },
    ],
  },

  {
    subject: "Invoice 2291 — Sablon Text licence",
    daysAgo: 11.3,
    labels: ["Label_Receipts"],
    messages: [
      {
        from: "vellum",
        to: ["me"],
        at: 0,
        html: INVOICE_HTML,
        text: "Invoice 2291 from Vellum Type Foundry. Sablon Text five-seat desktop licence £420.00, web licence 250k views/mo £180.00, VAT £120.00. Total £720.00, due in 14 days. Licence agreement attached.",
        attachments: [
          {
            filename: "vellum-invoice-2291.pdf",
            mime_type: "application/pdf",
            size: 148_204,
          },
          {
            filename: "sablon-licence-agreement.pdf",
            mime_type: "application/pdf",
            size: 312_880,
          },
        ],
      },
    ],
  },

  {
    subject: "Your Driftwork receipt — August",
    daysAgo: 13.7,
    labels: ["Label_Receipts"],
    messages: [
      {
        from: "payments",
        to: ["me"],
        at: 0,
        text: `Receipt for August.

Driftwork Team, 6 seats, £174.00. Charged to the card ending 4021 on 1 August. Your next invoice is on 1 September.

This is an internal test account, which is why the amount looks like that.`,
      },
    ],
  },

  {
    subject: "driftwork.io renews in 30 days",
    daysAgo: 15.2,
    labels: ["Label_Receipts"],
    messages: [
      {
        from: "registrar",
        to: ["me"],
        at: 0,
        text: `driftwork.io will renew automatically on 12 September for £38.00 for one year.

No action is needed. If you would like to change the renewal period or turn off automatic renewal, you can do so in your account until the day before.`,
      },
    ],
  },

  {
    subject: "The interface that admits it is guessing",
    daysAgo: 1.4,
    labels: ["Label_Newsletters"],
    unread: true,
    messages: [
      { from: "overcast", to: ["me"], at: 0, html: OVERCAST_HTML, text: "The Overcast No. 214 — the interface that admits it is guessing, plus three links: a field guide to keyboard-first apps, an argument against the three-pane layout, and a piece on latency budgets." },
    ],
  },

  {
    subject: "Your database is not the bottleneck, your fan-out is",
    daysAgo: 3.5,
    labels: ["Label_Newsletters"],
    messages: [
      { from: "kernel", to: ["me"], at: 0, html: KERNEL_HTML, text: "Kernel Panic issue 88 — nine hundred four-millisecond queries are still four seconds. On N+1 in the wild, why the slow version reads better, and a CI tool that counts queries per endpoint." },
    ],
  },

  {
    subject: "Notes on rereading",
    daysAgo: 6.8,
    labels: ["Label_Newsletters"],
    messages: [
      { from: "marginalia", to: ["me"], at: 0, html: MARGINALIA_HTML, text: "Marginalia, Saturday letter — on rereading, three short reviews, and a readers' list of books that are better the second time." },
    ],
  },

  {
    subject: "Software that outlives its funding",
    daysAgo: 12.1,
    labels: ["Label_Newsletters"],
    messages: [
      { from: "slowsoftware", to: ["me"], at: 0, html: SLOW_HTML, text: "Slow Software monthly — durability rather than uptime: own your data on disk, prefer boring formats, make the export the same code path as the backup. Members' call on the 12th." },
    ],
  },

  {
    subject: "[driftwork/atlas] Composer drops attachments on retry (#812)",
    daysAgo: 2.1,
    unread: true,
    messages: [
      {
        from: "github",
        to: ["me"],
        at: 0,
        html: `<div style="${GITHUB_STYLE}"><p style="margin:0 0 14px"><strong>theobrandt</strong> commented on issue <a href="https://github.com/driftwork/atlas/issues/812" style="color:#2f7d76">#812</a>:</p><blockquote style="margin:0;padding:2px 0 2px 14px;border-left:3px solid #e3ddd4;color:#3b3630">Reproduced. The retry path rebuilds the request from the draft record, and the draft record never held the attachment — it only ever held a reference to the upload, which is cleared when the first send starts.<br><br>Fix is to clear the upload reference on success rather than on attempt. Small change, but it wants a test that actually fails first.</blockquote></div>`,
        text: "theobrandt commented on issue #812: Reproduced. The retry path rebuilds the request from the draft record, and the draft record never held the attachment — it only held a reference to the upload, cleared when the first send starts. Fix is to clear on success rather than on attempt.",
      },
      {
        from: "github",
        to: ["me"],
        at: 240,
        html: `<div style="${GITHUB_STYLE}"><p style="margin:0 0 14px"><strong>priyaraman</strong> commented on issue <a href="https://github.com/driftwork/atlas/issues/812" style="color:#2f7d76">#812</a>:</p><blockquote style="margin:0;padding:2px 0 2px 14px;border-left:3px solid #e3ddd4;color:#3b3630">While you are in there: the composer shows the attachment chip after the send fails, so the person is looking at a file that is no longer attached. That is the part that generates the support ticket.</blockquote></div>`,
        text: "priyaraman commented on issue #812: While you are in there — the composer shows the attachment chip after the send fails, so the person is looking at a file that is no longer attached. That is the part that generates the support ticket.",
      },
      {
        from: "github",
        to: ["me"],
        at: 1420,
        html: `<div style="${GITHUB_STYLE}"><p style="margin:0 0 14px"><strong>theobrandt</strong> closed issue <a href="https://github.com/driftwork/atlas/issues/812" style="color:#2f7d76">#812</a> as completed via <a href="https://github.com/driftwork/atlas/pull/815" style="color:#2f7d76">#815</a>.</p></div>`,
        text: "theobrandt closed issue #812 as completed via #815.",
      },
    ],
  },

  {
    subject: "[driftwork/atlas] Rewrite the outbox drain loop (#815)",
    daysAgo: 1.8,
    messages: [
      {
        from: "github",
        to: ["me"],
        at: 0,
        html: `<div style="${GITHUB_STYLE}"><p style="margin:0 0 14px"><strong>theobrandt</strong> opened pull request <a href="https://github.com/driftwork/atlas/pull/815" style="color:#2f7d76">#815</a>: <strong>Rewrite the outbox drain loop</strong></p><p style="margin:0 0 10px;color:#3b3630">Drains in creation order, retries with backoff, and gives up after five attempts with the error surfaced on the account rather than swallowed. Fixes #812.</p><p style="margin:0;color:#6b635a;font-size:13px">+284 −96 across 7 files · 3 checks pending</p></div>`,
        text: "theobrandt opened pull request #815: Rewrite the outbox drain loop. Drains in creation order, retries with backoff, gives up after five attempts with the error surfaced on the account. Fixes #812. +284 −96 across 7 files.",
      },
      {
        from: "github",
        to: ["me"],
        at: 320,
        html: `<div style="${GITHUB_STYLE}"><p style="margin:0 0 14px"><strong>noraadeyemi</strong> approved <a href="https://github.com/driftwork/atlas/pull/815" style="color:#2f7d76">#815</a>:</p><blockquote style="margin:0;padding:2px 0 2px 14px;border-left:3px solid #e3ddd4;color:#3b3630">One comment on the backoff — cap it at a minute rather than letting it grow to eight. Nobody is helped by a send that retries three hours from now. Otherwise this is much clearer than what it replaces.</blockquote></div>`,
        text: "noraadeyemi approved #815: One comment on the backoff — cap it at a minute rather than letting it grow to eight. Nobody is helped by a send that retries three hours from now.",
      },
    ],
  },

  {
    subject: "[driftwork/atlas] Nightly end-to-end run failed",
    daysAgo: 0.6,
    unread: true,
    messages: [
      {
        from: "github",
        to: ["me"],
        at: 0,
        html: `<div style="${GITHUB_STYLE}"><p style="margin:0 0 12px"><strong>nightly-e2e</strong> failed on <code style="font:13px ui-monospace,Menlo,monospace;background:#f2ede5;border-radius:4px;padding:1px 5px">main</code></p><p style="margin:0 0 10px;color:#3b3630">2 of 61 tests failed, both in <code style="font:13px ui-monospace,Menlo,monospace;background:#f2ede5;border-radius:4px;padding:1px 5px">compose.spec.ts</code>:</p><pre style="background:#f5f1ea;border:1px solid #e3ddd4;border-radius:6px;padding:11px 13px;font:12.5px/1.5 ui-monospace,Menlo,monospace;overflow-x:auto;margin:0 0 10px;color:#8a3324">✗ sends a reply and shows it in the thread (timeout 5000ms)
✗ restores a draft after reload (element not found: [data-draft-chip])</pre><p style="margin:0;color:#6b635a;font-size:13px">Both passed on the previous run. Most recent change: #815.</p></div>`,
        text: "nightly-e2e failed on main. 2 of 61 tests failed in compose.spec.ts: 'sends a reply and shows it in the thread' timed out, and 'restores a draft after reload' could not find the draft chip. Both passed on the previous run. Most recent change: #815.",
      },
    ],
  },

  {
    subject: "Boiler service — access on Thursday morning?",
    daysAgo: 5.1,
    messages: [
      {
        from: "alan",
        to: ["me"],
        at: 0,
        text: `Dear Ms Adeyemi,

The annual boiler service is due at 14 Sedgwick Road. Our engineer has availability on Thursday between 9am and 1pm, and would need access for around forty-five minutes.

If Thursday does not suit, the following Tuesday afternoon is also open. Please let me know which you prefer and I will confirm with the engineer.

Kind regards,
Alan Whitcombe
Merrow Property Management`,
      },
      {
        from: "me",
        to: ["alan"],
        at: 194,
        text: `Hello Alan,

Thursday morning is fine, but I will be at work — my neighbour at number 12 has a key and is happy to let the engineer in. Her name is Mrs Achebe and she is in all morning.

Could you ask the engineer to look at the radiator in the back bedroom while he is there? It has not been warming properly since the spring and I suspect it needs bleeding rather than anything serious.

Best,
Nora`,
      },
      {
        from: "alan",
        to: ["me"],
        at: 271,
        text: `Noted on both counts — Thursday morning confirmed, and I have added the radiator to the job sheet. If it turns out to be more than bleeding, the engineer will call you before doing any work.

Kind regards,
Alan`,
      },
    ],
  },

  {
    subject: "Presupuesto para la identidad de Driftwork",
    daysAgo: 6.5,
    messages: [
      {
        from: "sofia",
        to: ["me"],
        at: 0,
        text: `Hola Nora,

Te mando el presupuesto para la identidad, como quedamos el martes.

Son seis semanas repartidas en tres fases: dos de investigación y territorio visual, dos de diseño de la marca, y dos de aplicación y manual. El precio es de 14.000 euros más IVA, con el 40% al empezar.

Una cosa que quiero decirte antes de que lo leas: en la llamada mencionaste que el logotipo actual "no está tan mal". Estoy de acuerdo. Creo que el problema no es la marca sino todo lo que la rodea — la tipografía, el color, el tono. Si prefieres, puedo hacerte una propuesta más corta que solo toque eso, por unos 6.000 euros.

Dime qué prefieres y lo ajusto.

Un abrazo,
Sofía`,
      },
      {
        from: "me",
        to: ["sofia"],
        at: 320,
        text: `Hola Sofía,

Gracias, muy claro todo. Me interesa mucho la segunda opción — creo que tienes razón en que el logotipo no es el problema.

¿Puedes mandarme esa propuesta más corta con un poco de detalle sobre qué incluye el manual? Lo llevo a Marcus la semana que viene y quiero que vea exactamente qué recibimos.

Un abrazo,
Nora`,
      },
    ],
  },

  {
    subject: "New sign-in on a Mac",
    daysAgo: 0.4,
    unread: true,
    messages: [
      {
        from: "accounts",
        to: ["me"],
        at: 0,
        html: SECURITY_HTML,
        text: "Your account nora@driftwork.io was signed in to on a new device: MacBook Pro, Safari, Porto, Portugal, today at 08:14. If this was not you, change your password and sign out of all sessions.",
      },
    ],
  },

  {
    subject: "Invitation: Design review @ Thursday 14 Aug, 15:00",
    daysAgo: 1.3,
    unread: true,
    messages: [
      {
        from: "calendar",
        to: ["me"],
        at: 0,
        text: `Priya Raman has invited you to Design review.

When: Thursday 14 August, 15:00 – 16:00 (Europe/London)
Where: Studio room / video link
Guests: Priya Raman (organiser), Nora Adeyemi, Theo Brandt, Marcus Feld

Description: Empty states, the failed-send state, and the type scale if there is time. Please look at the Figma before rather than during.`,
      },
    ],
  },

  {
    subject: "Updated invitation: Nora / Marcus 1:1 @ Monday 11:30",
    daysAgo: 2.7,
    messages: [
      {
        from: "calendar",
        to: ["me"],
        at: 0,
        text: `This event has been changed.

Nora / Marcus 1:1
When: Monday 18 August, 11:30 – 12:00 (was 10:00 – 10:30)
Where: Walk, weather permitting
Guests: Marcus Feld (organiser), Nora Adeyemi

Note from Marcus: moved because the investor call ran long last week and I would rather not do this one in a hurry.`,
      },
    ],
  },

  {
    subject: "Mum's birthday — are you coming down for the weekend?",
    daysAgo: 4.9,
    starred: true,
    messages: [
      {
        from: "yusuf",
        to: ["me"],
        at: 0,
        text: `Nor,

Mum's 70th is the weekend of the 27th and I am trying to work out numbers before I book anything.

The plan such as it is: lunch at the house on the Saturday for about twenty people, and then whoever is left goes to the pub. Aunty Bisi is coming from Manchester and has already asked twice whether you will be there, so consider yourself warned.

Can you do Friday night to Sunday? If you can get down Friday you can help me with the food, which is the actual reason I am asking.

Y`,
      },
      {
        from: "me",
        to: ["yusuf"],
        at: 148,
        text: `Friday to Sunday works. I will get the 6:40 out of Euston on Friday if you can collect me, otherwise I will get a taxi and complain about it for a year.

Tell me what to cook and I will do it. Not the jollof — you have strong opinions about the jollof and I would rather not spend Saturday morning defending mine.

What are we doing about a present? I do not want to turn up with a candle.`,
      },
      {
        from: "yusuf",
        to: ["me"],
        at: 205,
        text: `I will collect you. And you are right about the jollof.

Present: I have been thinking about the photos. There are four boxes of them in the loft, all loose, going back to before we were born. If we got a hundred of the good ones scanned and printed properly in an album, that is a real present and it costs about £120 between us.

I can do the scanning if you do the choosing, which is the harder job. Here is one to show you what we are working with — Lagos, 1987, and she is wearing the green.`,
        attachments: [
          {
            filename: "lagos-1987.jpg",
            mime_type: "image/jpeg",
            size: 1_842_776,
          },
        ],
      },
      {
        from: "me",
        to: ["yusuf"],
        at: 261,
        text: `That is a much better present than anything either of us would have bought.

I will do the choosing. Bring the boxes down Friday and we will do it at the kitchen table after she has gone to bed.`,
      },
    ],
  },

  {
    subject: "Climbing Wednesday?",
    daysAgo: 3.1,
    messages: [
      {
        from: "tess",
        to: ["me"],
        at: 0,
        text: `Are you climbing Wednesday? I have a session booked at 7 and the person I was going with has pulled a shoulder.

Fair warning: they have reset the whole overhang wall and everything on it is now, in my opinion, sandbagged by two grades.`,
      },
      {
        from: "me",
        to: ["tess"],
        at: 41,
        text: `In. I will be there at 7 but might be five minutes late — Wednesday is the day our standup overruns.

Sandbagged is what people say when they cannot do the moves.`,
      },
    ],
  },

  {
    subject: "You're speaking at Interlude — final details",
    daysAgo: 8.2,
    labels: ["Label_Travel"],
    messages: [
      {
        from: "ines",
        to: ["me"],
        at: 0,
        text: `Hello Nora,

Final details for your talk at Interlude.

You are on at 14:20 on the Thursday, in the main room, 25 minutes plus 10 for questions. The room seats 400 and will be about two thirds full at that time of day.

Two things I need from you by the 5th: a title we can print, and a one-paragraph description. The working title we have is "Keyboards, latency and the shape of software", which I quite like but I suspect you have opinions.

Travel and the hotel are booked and confirmed under your name.`,
      },
      {
        from: "me",
        to: ["ines"],
        at: 1180,
        text: `Hello Inés,

The working title is close but a bit grand. Let us go with "Nine keys: designing software for people who never touch the mouse".

Description: Every keyboard-first tool converges on the same small set of gestures, and the ones that succeed are the ones that admit how few people will ever learn a tenth. A talk about latency budgets, undo as a design primitive, and what happens to an interface when you take the mouse away from it.

See you on the Thursday.

Nora`,
      },
    ],
  },

  {
    subject: "Would you come on the podcast?",
    daysAgo: 10.4,
    unread: true,
    messages: [
      {
        from: "gustav",
        to: ["me"],
        at: 0,
        text: `Hi Nora,

I make Aperture, a podcast about how software gets built — long conversations, no ads, about 12,000 listeners an episode. Recent guests have been an operating system historian and the person who maintains the world's most widely used date library.

I would like to talk to you about the offline work, and specifically about the decisions you made that turned out to be wrong. Most people will not talk about that part, which is why the episodes that do are the ones people write in about.

An hour, recorded remotely, and you get the audio before it goes out. Interested?`,
      },
    ],
  },

  {
    subject: "Thank you (a small one)",
    daysAgo: 14.6,
    messages: [
      {
        from: "tess",
        to: ["me"],
        at: 0,
        text: `Not about climbing.

I used the thing you built at work last week to dig myself out of a genuinely awful inbox situation after two weeks of leave — 1,400 messages, most of them noise. Got to zero in about forty minutes, mostly by holding down j and e.

Anyway. Somebody built that on purpose and I thought you should hear it worked.`,
      },
    ],
  },

  {
    subject: "Your statement is ready",
    daysAgo: 16.9,
    messages: [
      {
        from: "bank",
        to: ["me"],
        at: 0,
        text: `Your August statement for account ending 4021 is now available.

Sign in to view it. For your security, we never include statements as attachments and we will never ask you for your full password or card details by email.`,
      },
    ],
  },

  {
    subject: "Appointment reminder — Tuesday 9:20am",
    daysAgo: 11.8,
    messages: [
      {
        from: "dentist",
        to: ["me"],
        at: 0,
        text: `This is a reminder of your appointment with Ms Farooqi on Tuesday 19 August at 9:20am.

If you need to change or cancel, please give us 24 hours' notice. Reply CANCEL to this message or call the practice on 020 7946 0912.`,
      },
    ],
  },

  {
    subject: "Your hold is ready to collect",
    daysAgo: 13.1,
    messages: [
      {
        from: "library",
        to: ["me"],
        at: 0,
        text: `The item you reserved is ready to collect from Stoke Newington Library.

The Craftsman — Richard Sennett

Please collect within seven days, after which the hold passes to the next reader. The library is open until 7pm on weekdays and until 5pm on Saturday.`,
      },
    ],
  },

  {
    subject: "Fen Road Allotments — committee minutes, August",
    daysAgo: 18.4,
    messages: [
      {
        from: "allotment",
        to: ["me"],
        at: 0,
        text: `Minutes of the August meeting, in brief.

The water supply to the top plots will be repaired on the 22nd; there will be no standpipe for two days and the committee is arranging a bowser. The waiting list stands at 31, which is the longest it has been. The bonfire rule remains as it was, despite a spirited attempt to change it.

Plot 14 — a reminder that the hedge on the eastern boundary is the plot holder's responsibility and is currently well over the agreed height.

Next meeting is 11 September, 7pm, in the shed.`,
      },
    ],
  },

  {
    subject: "Quick question about your engineering hiring",
    daysAgo: 9.8,
    messages: [
      {
        from: "brett",
        to: ["me"],
        at: 0,
        text: `Hi Nora,

I noticed Driftwork is growing the engineering team and wanted to reach out. We help companies like yours reduce time-to-hire by 40% through our AI-powered sourcing platform.

Would you be open to a quick 15-minute call this week to see if there is a fit? I have Thursday at 11 or Friday at 2.

Best,
Brett Sundberg
ScaleVelocity`,
      },
    ],
  },

  {
    subject: "Series A conversations — worth an intro?",
    daysAgo: 20.3,
    messages: [
      {
        from: "darius",
        to: ["me"],
        at: 0,
        text: `Nora — Marcus mentioned you at dinner and I have been following what Driftwork is doing for a while.

I am not going to pretend this is anything other than what it is: we invest at Series A and I would like to be in the conversation when you have one. No deck required, no process. If it is useful I am happy to introduce you to two of our portfolio founders in adjacent spaces, with no expectation attached.

If the timing is wrong, tell me and I will go away for six months.

Darius`,
      },
    ],
  },

  {
    subject: "Re: contract for the Porto workshop",
    daysAgo: 7.9,
    placement: "sent",
    messages: [
      {
        from: "me",
        to: ["ines"],
        at: 0,
        text: `Hello Inés,

Signed contract attached. Two small changes, both marked.

Clause 6 said the recording could be used "in any medium in perpetuity", which I have narrowed to the conference archive and the podcast feed. Not because I mind, but because in perpetuity is a long time and the clause cost nothing to tighten.

Clause 9 had my travel reimbursed within 60 days, which I have made 30. Sixty days after October is Christmas.

Everything else is fine as written.

Nora`,
        attachments: [
          {
            filename: "interlude-speaker-agreement-signed.pdf",
            mime_type: "application/pdf",
            size: 204_118,
          },
        ],
      },
    ],
  },

  {
    subject: "Notes from the pricing call",
    daysAgo: 10.9,
    placement: "sent",
    messages: [
      {
        from: "me",
        to: ["marcus", "delphine"],
        at: 0,
        text: `Notes from this morning, while they are fresh.

The per-seat model is not the problem. The problem is that the middle tier has no reason to exist — it is the same product with a higher number next to it, and every customer who lands there works out within a month that they should be on the lower one.

Two options. Either the middle tier gets something real (SSO is the obvious candidate, since that is what people ask for at that size), or we delete it and have two tiers.

I would delete it, but I recognise that is easy to say when I am not the one explaining it to the eleven accounts sitting on it.`,
      },
    ],
  },

  {
    subject: "Intro: Priya <> Sofía",
    daysAgo: 6.4,
    placement: "sent",
    messages: [
      {
        from: "me",
        to: ["priya", "sofia"],
        at: 0,
        text: `Priya — Sofía runs a studio in Madrid and is doing the identity work for us. She is the person who convinced me our logo is fine and everything around it is not.

Sofía — Priya designs the product itself. If the identity is going to survive contact with the interface, you two should be talking directly rather than through me.

I am stepping out of the thread. Have fun.`,
      },
    ],
  },

  {
    subject: "Refund request — order 88213",
    daysAgo: 17.2,
    placement: "sent",
    messages: [
      {
        from: "me",
        to: ["vellum"],
        at: 0,
        text: `Hello,

I ordered the wrong licence tier on order 88213 — a single-seat desktop licence, where I need the five-seat. I have since placed the correct order (2291).

Could you refund 88213? Happy for it to go back to the original card. Sorry for the noise.

Nora Adeyemi
Driftwork`,
      },
    ],
  },

  {
    subject: "Thanks for Tuesday",
    daysAgo: 12.6,
    placement: "sent",
    messages: [
      {
        from: "me",
        to: ["hannah"],
        at: 0,
        text: `Hannah — thank you for Tuesday, and for being straight with me about the second candidate's salary expectations before rather than after.

We are going to make an offer to the first candidate this week. If she says no I will call you rather than emailing, because I suspect the answer to "what would have made the difference" is a conversation.`,
      },
    ],
  },

  {
    subject: "Availability next week",
    daysAgo: 19.5,
    placement: "sent",
    messages: [
      {
        from: "me",
        to: ["gustav"],
        at: 0,
        text: `Hello Gustav,

Yes, with one condition: I would like to talk about the sync engine rewrite we abandoned, not just the one that worked. The abandoned one is the more interesting story and nobody has ever asked me about it.

Tuesday or Wednesday afternoon next week both work. I am in London, so anything from 2pm your time onwards.

Nora`,
      },
    ],
  },

  {
    subject: "Q1 planning — my comments on the doc",
    daysAgo: 34.7,
    placement: "archive",
    messages: [
      {
        from: "marcus",
        to: ["me", "theo", "priya"],
        at: 0,
        text: `Comments are in the doc. The big one is that we have committed to four things in a quarter where we have capacity for two and a half.

I have marked which two I would keep. I expect disagreement about the third.`,
      },
      {
        from: "theo",
        to: ["marcus", "me", "priya"],
        at: 340,
        text: `Agreed on the two. On the third, I would rather do half of it properly than all of it badly — the search work has a natural stopping point after the index, and everything after that is polish we can defer without shipping something broken.`,
      },
    ],
  },

  {
    subject: "Laptop replacement — approved",
    daysAgo: 41.2,
    placement: "archive",
    messages: [
      {
        from: "delphine",
        to: ["me"],
        at: 0,
        text: `Approved — order it whenever you like and send me the receipt.

For the record, the old one is four years old and the battery is at 71%, so nobody is going to argue with you. Please do actually hand the old one back this time; we are meant to be wiping and reselling them.`,
      },
    ],
  },

  {
    subject: "50% off annual plans — today only",
    daysAgo: 2.2,
    placement: "trash",
    messages: [
      {
        from: "deals",
        to: ["me"],
        at: 0,
        text: `Our biggest sale of the year ends at midnight.

50% off every annual plan. No code needed — the discount is applied at checkout. This is the last time we will offer this in 2026.`,
      },
    ],
  },

  {
    subject: "Re: quick question",
    daysAgo: 8.9,
    placement: "trash",
    messages: [
      {
        from: "brett",
        to: ["me"],
        at: 0,
        text: `Just floating this back to the top of your inbox in case it got buried.

Still happy to do 15 minutes whenever suits.`,
      },
    ],
  },

  {
    subject: "Your parcel could not be delivered",
    daysAgo: 5.7,
    placement: "trash",
    messages: [
      {
        from: "parcel",
        to: ["me"],
        at: 0,
        text: `We attempted delivery of your parcel today and nobody was available to receive it.

A redelivery fee of £1.45 is required to reschedule. Please confirm your address and payment details within 48 hours or the parcel will be returned to sender.`,
      },
    ],
  },

  {
    subject: "URGENT: account verification required within 24 hours",
    daysAgo: 3.4,
    placement: "spam",
    messages: [
      {
        from: "verify",
        to: ["me"],
        at: 0,
        text: `Dear Customer,

Our security system has detected unusual activity on your acount and access has been temporarily limited.

You must verify your identity within 24 hours or your acount will be permanently suspended. Click the link below and confirm your details to restore full access.

Failure to act will result in loss of all data.

Security Department`,
      },
    ],
  },

  {
    subject: "CONGRATULATIONS - You have been selected",
    daysAgo: 6.1,
    placement: "spam",
    messages: [
      {
        from: "lottery",
        to: ["me"],
        at: 0,
        text: `ATTENTION BENEFICIARY,

This is to inform you that your email address was selected in our international promotional draw held in Amsterdam. You are entitled to the sum of £850,000.00 (Eight Hundred and Fifty Thousand Pounds).

To begin processing please reply with your full name, address, telephone number and a copy of identification. A small administrative fee applies for the release of funds.

Yours faithfully,
Dr. Emmanuel Rutherford
Claims Director`,
      },
    ],
  },
];

const DRAFTS = [
  {
    client_id: "demo-draft-01",
    thread_index: 1, // the composer debate
    mode: "reply" as const,
    to: ["theo", "priya", "marcus", "kenji"] as Array<keyof typeof PEOPLE>,
    subject: "Re: Composer v3: do we ship it without offline?",
    body_text: `One more thing before Thursday, and then I will stop.

When the failed-send state lands, the copy matters more than the design. "Couldn't send" is honest. "Something went wrong" is not, because we know exactly what went wrong and`,
    minutesAgo: 90,
  },
  {
    client_id: "demo-draft-02",
    mode: "new" as const,
    to: ["sofia"] as Array<keyof typeof PEOPLE>,
    subject: "Fechas para la propuesta corta",
    body_text: `Hola Sofía,

Una pregunta rápida sobre el calendario: si empezamos la primera semana de octubre, ¿cuándo tendríamos algo que enseñar? Lo pregunto porque el offsite es del 14 al 16 y sería`,
    minutesAgo: 310,
  },
];

// ---------------------------------------------------------------------------
// The seeder
// ---------------------------------------------------------------------------

/**
 * The owner's address is resolved per mailbox, not taken from `ME`: a second
 * demo account on the same deployment gets a suffixed address, and every row
 * that says "me" has to agree with it or the app cannot tell which messages
 * the reader sent.
 */
function personFor(key: keyof typeof PEOPLE | "me", owner: Person): Person {
  return key === "me" ? owner : PEOPLE[key];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function snippetFrom(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
}

/** Placement decides the system labels; per-thread `labels` add to them. */
function baseLabelsFor(thread: SeedThread): string[] {
  switch (thread.placement ?? "inbox") {
    case "archive":
      return [];
    case "sent":
      return [L.SENT];
    case "trash":
      return [L.TRASH];
    case "spam":
      return [L.SPAM];
    default:
      return [L.INBOX];
  }
}

async function findFreeDemoEmail(ctx: any): Promise<string> {
  const [local, domain] = ME.email.split("@");
  for (let i = 0; i < 200; i++) {
    const email = i === 0 ? ME.email : `${local}+${i + 1}@${domain}`;
    const taken = await ctx.db
      .query("accounts")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    if (!taken) return email;
  }
  return `${local}+${Math.floor(Date.now() % 100000)}@${domain}`;
}

/**
 * Build a fresh demo mailbox. Every seed makes its own account, so two
 * people on one deployment never share a mailbox. Anonymous callers get a
 * legacy token back (the zero-signup demo); a signed-in Convex Auth caller
 * gets the mailbox attached to their roster and `token: null`.
 */
export const seed = mutation({
  args: {
    // Present: attach the demo mailbox to the caller's EXISTING session
    // instead of minting a new one. Only a caller already holding the token
    // can use it — the same trust as every other authed call.
    attach_token: v.optional(v.string()),
  },
  handler: async (ctx, { attach_token }) => {
    const now = Date.now();
    const email = await findFreeDemoEmail(ctx);
    const owner: Person = { name: ME.name, email };

    const accountId = await ctx.db.insert("accounts", {
      email,
      name: ME.name,
      picture: undefined,
      provider: "demo" as const,
      sync_status: "idle" as const,
      last_synced_at: now,
      updated_at: now,
    });

    await seedDemoCalendar(ctx, accountId, email, now);

    for (const label of SYSTEM_LABELS) {
      await ctx.db.insert("labels", {
        account_id: accountId,
        gmail_id: label.gmail_id,
        name: label.name,
        kind: "system" as const,
        updated_at: now,
      });
    }
    for (const label of USER_LABELS) {
      await ctx.db.insert("labels", {
        account_id: accountId,
        gmail_id: label.gmail_id,
        name: label.name,
        kind: "user" as const,
        color: label.color,
        updated_at: now,
      });
    }

    const threadIds: string[] = [];

    for (let index = 0; index < THREADS.length; index++) {
      const thread = THREADS[index];
      const threadGmailId = `demo-thread-${pad(index + 1)}`;
      threadIds.push(threadGmailId);
      const startedAt = now - Math.round(thread.daysAgo * 24 * 60 * 60 * 1000);
      const base = [...baseLabelsFor(thread), ...(thread.labels ?? [])];
      if (thread.starred) base.push(L.STARRED);

      // Only the newest inbound message is unread — the way a real thread you
      // half-read looks.
      let lastInbound = -1;
      thread.messages.forEach((message, i) => {
        if (message.from !== "me") lastInbound = i;
      });

      await ctx.db.insert("threads", {
        account_id: accountId,
        gmail_id: threadGmailId,
        subject: thread.subject,
        snippet: "",
        participants: [],
        message_count: 0,
        last_at: startedAt,
        label_ids: [],
        is_unread: false,
        is_starred: false,
        has_attachments: false,
        updated_at: now,
      });

      for (let i = 0; i < thread.messages.length; i++) {
        const message = thread.messages[i];
        const sender = personFor(message.from, owner);
        const outbound = message.from === "me";
        const unread = !!thread.unread && i === lastInbound && !outbound;

        const labelIds = [...base];
        // The owner's own replies inside a received thread are what Gmail
        // labels SENT, which is how they show up in the Sent view.
        if (outbound) labelIds.push(L.SENT);
        if (unread) labelIds.push(L.UNREAD);

        const recipients = (message.to ?? (outbound ? [] : ["me"])).map((key) =>
          personFor(key, owner),
        );
        const copies = (message.cc ?? []).map((key) => personFor(key, owner));

        await ctx.db.insert("messages", {
          account_id: accountId,
          thread_gmail_id: threadGmailId,
          gmail_id: `demo-msg-${pad(index + 1)}-${pad(i + 1)}`,
          from: { name: sender.name, email: sender.email },
          to: recipients.map((p) => ({ name: p.name, email: p.email })),
          cc: copies.map((p) => ({ name: p.name, email: p.email })),
          bcc: [],
          date: startedAt + message.at * 60 * 1000,
          snippet: snippetFrom(message.text),
          body_html: message.html,
          body_text: message.text,
          label_ids: normalizeLabels(labelIds),
          is_unread: unread,
          attachments: (message.attachments ?? []).map((a, ai) => ({
            ...a,
            gmail_attachment_id: `demo-att-${pad(index + 1)}-${pad(i + 1)}-${ai + 1}`,
          })),
          header_message_id: `<demo-${pad(index + 1)}-${pad(i + 1)}@mail.local>`,
          in_reply_to:
            i === 0
              ? undefined
              : `<demo-${pad(index + 1)}-${pad(i)}@mail.local>`,
          references:
            i === 0
              ? undefined
              : thread.messages
                  .slice(0, i)
                  .map((_, j) => `<demo-${pad(index + 1)}-${pad(j + 1)}@mail.local>`)
                  .join(" "),
          updated_at: now,
        });
      }

      // The same derivation every other write path uses — no second source of
      // truth for what a thread row says.
      const firstInbound = thread.messages.find((m) => m.from !== "me");
      const category =
        firstInbound && thread.placement !== "spam" && thread.placement !== "trash"
          ? DEMO_CATEGORIES[firstInbound.from as keyof typeof PEOPLE]
          : undefined;
      await recomputeThread(ctx, accountId, threadGmailId, {
        subject: thread.subject,
        ...(category
          ? { category, category_source: "heuristic" as const }
          : {}),
      });
    }

    for (const topic of [
      { name: "Composer release", description: "Composer reliability, attachments, offline support and outbox work", pattern: /Composer|outbox|Nightly end-to-end/i },
      { name: "Portugal offsite", description: "Porto offsite planning, Lisbon flights, accommodation and workshop contracts", pattern: /Porto|Lisbon|Casa Alvorada/i },
      { name: "Design system", description: "Typography, empty states and design review discussions", pattern: /Type scale|Empty states|Design review/i },
    ]) {
      const cluster = await ensureCluster(ctx, accountId, { name: topic.name, description: topic.description, source: "ai" }, now);
      const ids = THREADS.flatMap((thread, index) => topic.pattern.test(thread.subject) ? [threadIds[index]] : []);
      await placeThreads(ctx, accountId, ids, cluster._id, "ai", now);
    }

    for (const memory of DEMO_MEMORIES) {
      await ctx.db.insert("memories", {
        account_id: accountId,
        kind: memory.kind,
        text: memory.text,
        contact_email: memory.contact_email,
        category: memory.category,
        source: memory.source,
        created_at: now,
        updated_at: now,
      });
    }

    // Two live reminders: a snooze parked on an archived thread, a follow-up
    // watch on something Nora sent and is still waiting on. The Later and
    // Waiting views work on first run.
    const tomorrow9 = new Date(now + 24 * 60 * 60 * 1000);
    tomorrow9.setHours(9, 0, 0, 0);
    const snoozeIndex = THREADS.findIndex((t) => t.placement === "archive");
    if (snoozeIndex >= 0) {
      const t = await ctx.db
        .query("threads")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", accountId).eq("gmail_id", threadIds[snoozeIndex]),
        )
        .unique();
      if (t) {
        await ctx.db.insert("reminders", {
          account_id: accountId,
          thread_gmail_id: t.gmail_id,
          kind: "snooze",
          remind_at: tomorrow9.getTime(),
          baseline_last_at: t.last_at,
          status: "armed",
          created_at: now,
          updated_at: now,
        });
      }
    }
    const waitingIndex = THREADS.findIndex(
      (t) =>
        t.placement === "sent" &&
        t.messages[t.messages.length - 1]?.from === "me",
    );
    if (waitingIndex >= 0) {
      const t = await ctx.db
        .query("threads")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", accountId).eq("gmail_id", threadIds[waitingIndex]),
        )
        .unique();
      if (t) {
        await ctx.db.insert("reminders", {
          account_id: accountId,
          thread_gmail_id: t.gmail_id,
          kind: "followup",
          remind_at: now + 2 * 24 * 60 * 60 * 1000,
          baseline_last_at: t.last_at,
          status: "armed",
          created_at: now,
          updated_at: now,
        });
      }
    }

    for (const draft of DRAFTS) {
      await ctx.db.insert("drafts", {
        account_id: accountId,
        client_id: draft.client_id,
        thread_gmail_id:
          draft.thread_index === undefined
            ? undefined
            : threadIds[draft.thread_index],
        to: draft.to.map((key) => ({
          name: PEOPLE[key].name,
          email: PEOPLE[key].email,
        })),
        cc: [],
        bcc: [],
        subject: draft.subject,
        body_text: draft.body_text,
        reply_to_gmail_id:
          draft.thread_index === undefined
            ? undefined
            : `demo-msg-${pad(draft.thread_index + 1)}-01`,
        mode: draft.mode,
        updated_at: now - draft.minutesAgo * 60 * 1000,
      });
    }

    if (attach_token) {
      const ok = await attachAccountToSession(
        ctx,
        await hashToken(attach_token),
        accountId,
      );
      if (!ok) throw new Error("Unauthorized: unknown token");
      return {
        token: attach_token,
        accountId: accountId as Id<"accounts">,
        email,
        threads: THREADS.length,
      };
    }

    // A signed-in Convex Auth caller: the demo mailbox joins their roster and
    // no legacy token is minted — their JWT already names them. The
    // zero-signup path below is untouched.
    const callerId = await authUserId(ctx);
    if (callerId) {
      await ctx.db.patch(accountId, { user_id: callerId, updated_at: now });
      const existingState = await ctx.db
        .query("client_state")
        .withIndex("by_user", (q) => q.eq("user_id", callerId))
        .unique();
      if (!existingState) {
        await ctx.db.insert("client_state", {
          user_id: callerId,
          theme: "system" as const,
          rail_collapsed: false,
          density: "compact" as const,
          updated_at: now,
        });
      }
      return {
        token: null,
        accountId: accountId as Id<"accounts">,
        email,
        threads: THREADS.length,
      };
    }

    const userId = await ensureUserForAccount(
      ctx,
      (await ctx.db.get(accountId))!,
    );
    // Starter prefs belong to the user, like every prefs row.
    await ctx.db.insert("client_state", {
      user_id: userId,
      theme: "system" as const,
      rail_collapsed: false,
      density: "compact" as const,
      updated_at: now,
    });
    const token = await createAuthSession(ctx, userId);
    return {
      token,
      accountId: accountId as Id<"accounts">,
      email,
      threads: THREADS.length,
    };
  },
});

/** Test and development helper: tear a demo mailbox down completely. */
export const reset = mutation({
  // Authenticated: the caller can only wipe the demo account its own
  // credential (Convex Auth identity or legacy token) resolves to — never an
  // arbitrary account id.
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const account = await requireAccount(ctx, token);
    if (account.provider !== "demo") {
      throw new Error("reset only applies to demo accounts");
    }
    // Demo mailboxes are small (fixture-sized), so the row wipe completes
    // inline — tests depend on reset being synchronous.
    while (!(await wipeAccountRowsBatch(ctx, account._id, 2000))) {
      // next batch
    }
    await deleteAccountAndMaybeUser(ctx, account);
    return { reset: true };
  },
});
