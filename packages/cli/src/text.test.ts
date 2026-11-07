import { describe, expect, test } from "bun:test";
import { htmlToText, parseAddresses, stripQuotes } from "./text";

describe("parseAddresses", () => {
  test("names, bare addresses, separators", () => {
    expect(parseAddresses('Ada Lovelace <ada@x.org>, grace@y.org; "Bob" <bob@z.io>')).toEqual([
      { name: "Ada Lovelace", email: "ada@x.org" },
      { email: "grace@y.org" },
      { name: "Bob", email: "bob@z.io" },
    ]);
    expect(parseAddresses(["a@b.c", "d@e.f"])).toHaveLength(2);
    expect(parseAddresses(undefined)).toEqual([]);
  });
  test("rejects words without an @", () => {
    expect(() => parseAddresses("ada")).toThrow(/Not an email address/);
  });
});

describe("htmlToText", () => {
  test("blocks, links, entities, noise", () => {
    const html =
      "<html><head><style>p{}</style></head><body><p>Hi&nbsp;there &amp; welcome</p>" +
      '<div>See <a href="https://x.org/a">the doc</a> and <a href="https://y.org">https://y.org</a></div>' +
      "<ul><li>one</li><li>two</li></ul><!-- c --><script>x()</script></body></html>";
    expect(htmlToText(html)).toBe(
      "Hi there & welcome\n\nSee the doc (https://x.org/a) and https://y.org\n\n- one\n- two",
    );
  });
});

describe("stripQuotes", () => {
  test("drops the trail and the signature", () => {
    expect(stripQuotes("Yes, works.\n\nOn Tue, Ada wrote:\n> old\n> stuff\n-- \nsig")).toBe(
      "Yes, works.",
    );
  });
});
