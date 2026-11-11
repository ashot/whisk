import { expect, test } from "bun:test";
import { addressRows, recipientsLine } from "./format";
import type { Message } from "../store/types";

const me = { email: "me@example.com" };
const ada = { name: "Ada", email: "ada@example.com" };

// The recipients line is the only way into a message's details, so it must
// exist whenever the message names anyone, the reader alone included.
test("a message to the reader alone reads 'to me'", () => {
  expect(recipientsLine({ to: [me] }, me)).toBe("to me");
});

test("others come first, the reader as + me, cc counted", () => {
  expect(recipientsLine({ to: [ada, me] }, me)).toBe("to Ada + me");
  expect(recipientsLine({ to: [ada], cc: [me] }, me)).toBe("to Ada + me");
  expect(recipientsLine({ to: [ada] }, me)).toBe("to Ada");
});

test("no named recipient (bcc, undisclosed list) has no line", () => {
  expect(recipientsLine({ to: [] }, me)).toBeNull();
});

test("address rows keep only the headers the message carries", () => {
  const m = { from: ada, to: [me], cc: [], reply_to: { email: "no-reply@example.com" } } as unknown as Message;
  expect(addressRows(m).map((r) => r.label)).toEqual(["From", "To", "Reply-To"]);
});
