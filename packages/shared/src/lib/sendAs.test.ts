import { expect, test } from "bun:test";
import { fromAddress, isOwnAddress, sendAddresses } from "./sendAs";

const plain = { email: "me@gmail.com", name: "Me" };
const aliased = {
  ...plain,
  send_as: [
    { email: "me@gmail.com" },
    { email: "me@work.com", name: "Me at Work", is_default: true },
  ],
};

test("a mailbox whose aliases were never read sends as itself", () => {
  expect(sendAddresses(plain)).toEqual([{ name: "Me", email: "me@gmail.com" }]);
  expect(fromAddress(plain)).toEqual({ name: "Me", email: "me@gmail.com" });
});

test("Gmail's default comes first, and an alias with no name takes the account's", () => {
  expect(sendAddresses(aliased)).toEqual([
    { name: "Me at Work", email: "me@work.com" },
    { name: "Me", email: "me@gmail.com" },
  ]);
});

test("the From is the chosen alias, else the default", () => {
  expect(fromAddress(aliased).email).toBe("me@work.com");
  expect(fromAddress(aliased, "ME@gmail.com").email).toBe("me@gmail.com");
  // Anything the mailbox may not send as falls back to the default.
  expect(fromAddress(aliased, "someone@else.com").email).toBe("me@work.com");
});

test("every alias is mine", () => {
  expect(isOwnAddress(aliased, "Me@Work.com")).toBe(true);
  expect(isOwnAddress(aliased, "me@gmail.com")).toBe(true);
  expect(isOwnAddress(aliased, "ada@example.com")).toBe(false);
});
