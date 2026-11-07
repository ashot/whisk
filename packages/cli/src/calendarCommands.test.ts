import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { ConvexHttpClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import { registerCalendar } from "./commands/calendar";

const accounts = ["a", "b"].map(id => ({ _id: id, email: `${id}@example.com`, provider: "demo" }));
const calendars = accounts.map(a => ({ _id: `c-${a._id}`, account_id: a._id, google_id: "work", summary: "Work", access_role: "owner", primary: true }));
const events = accounts.map(a => ({ _id: `e-${a._id}`, account_id: a._id, calendar_google_id: "work", start: Date.now(), end: Date.now() + 3600000, summary: "Review", status: "confirmed", all_day: false }));
let output: string[];
let cleanup: () => void;

beforeEach(() => {
  const previousToken = process.env.WHISK_TOKEN;
  process.env.WHISK_TOKEN = "test-only";
  output = [];
  const log = spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
  const query = spyOn(ConvexHttpClient.prototype, "query").mockImplementation(async ref => {
    switch (getFunctionName(ref)) {
      case "sync:getAccount": return { accounts, outbound_pending: 0 };
      case "calendar/read:listCalendars": return calendars;
      case "calendar/read:listEvents": return { rows: events, nextSince: 1, hasMore: false };
      default: throw new Error(`Unexpected query ${getFunctionName(ref)}`);
    }
  });
  const mutation = spyOn(ConvexHttpClient.prototype, "mutation").mockImplementation(async ref => {
    if (getFunctionName(ref) !== "dispatch:dispatch") throw new Error("Unexpected mutation");
    return { event_id: "demo-event" };
  });
  cleanup = () => {
    log.mockRestore();
    query.mockRestore();
    mutation.mockRestore();
    if (previousToken === undefined) delete process.env.WHISK_TOKEN;
    else process.env.WHISK_TOKEN = previousToken;
  };
});

afterEach(() => cleanup());

async function run(args: string[]) {
  const program = new Command().exitOverride();
  registerCalendar(program);
  await program.parseAsync(args, { from: "user" });
  return JSON.parse(output.join("\n"));
}

for (const verb of ["today", "week", "calendars"]) {
  test(`calendar ${verb} honors nested JSON and account flags`, async () => {
    const rows = await run(["cal", verb, "--json", "--account", "b@example.com"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe("b");
  });
  test(`calendar ${verb} inherits flags before the subcommand`, async () => {
    const rows = await run(["cal", "--json", "--account", "a@example.com", verb]);
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe("a");
  });
}

test("default calendar timeline honors JSON", async () => {
  expect(await run(["cal", "--json"])).toHaveLength(2);
});

test("calendar create honors JSON without provider writes", async () => {
  expect(await run(["cal", "add", "Review", "--start", "tomorrow 9am", "--from", "a@example.com", "--json"])).toEqual({ event_id: "demo-event" });
});
