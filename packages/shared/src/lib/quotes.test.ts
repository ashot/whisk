import { describe, expect, test } from "bun:test";
import { newContent, parseAttribution, parseHeaderDate, opensForward, splitQuotedText, writtenPart } from "./quotes";

describe("parseAttribution", () => {
  test("Gmail, name after the time", () => {
    const a = parseAttribution("On Wed, Apr 29, 2026 at 6:14 PM Green, Jonathan <jg@amazon.com> wrote:");
    expect(a?.name).toBe("Green, Jonathan");
    expect(a?.date).toBe(new Date(2026, 3, 29, 18, 14).getTime());
  });
  test("Gmail, comma before the name", () => {
    const a = parseAttribution("On Mon, Sep 28, 2026 at 11:43 AM, Jonathan Green <jg@\namazon.com> wrote:");
    expect(a?.name).toBe("Jonathan Green");
    expect(a?.date).toBe(new Date(2026, 8, 28, 11, 43).getTime());
  });
  test("Apple Mail", () => {
    const a = parseAttribution("On Apr 29, 2026, at 6:14 PM, Jason Benn <jason@union.app> wrote:");
    expect(a?.name).toBe("Jason Benn");
  });
  test("Outlook header block", () => {
    const a = parseAttribution(
      "From: Jason Benn <jason@union.app> Sent: Wednesday, April 29, 2026 4:12 PM To: Samvit <s@union.app> Subject: RE: hi",
    );
    expect(a).toEqual({ name: "Jason Benn", date: new Date(2026, 3, 29, 16, 12).getTime() });
  });
  test("address only", () => {
    expect(parseAttribution("On Tue, 3 Mar 2026 09:00, ada@x.org wrote:")?.name).toBe("ada@x.org");
  });
  test("numeric dates stay unknown", () => {
    expect(parseHeaderDate("4/5/2026 10:00")).toBeUndefined();
  });
});

describe("splitQuotedText", () => {
  test("wrapped Gmail header", () => {
    const s = splitQuotedText("Sounds good.\n\nOn Mon, Sep 28, 2026 at 11:43 AM, Jon <jon@\nx.com> wrote:\n> old\n> On Sun, Ada <a@x.org> wrote:\n>> older");
    expect(s?.fresh).toBe("Sounds good.");
    expect(s?.quoted.startsWith("On Mon")).toBe(true);
    expect(s?.attribution?.name).toBe("Jon");
    expect(s?.count).toBe(2);
  });
  test("Outlook plain text", () => {
    const s = splitQuotedText("Thanks!\n\nFrom: Ada <a@x.org>\nSent: Friday, September 18, 2026 2:45 PM\nTo: Me\nSubject: RE: plan\n\nold");
    expect(s?.fresh).toBe("Thanks!");
    expect(s?.attribution?.name).toBe("Ada");
  });
  test("interleaved inline replies stay whole", () => {
    expect(splitQuotedText("Hi\n> question one\nanswer one\n> question two\nanswer two")).toBeNull();
  });
  test("forwards are never folded", () => {
    expect(splitQuotedText("FYI\n\n---------- Forwarded message ---------\nFrom: Ada <a@x.org>\nDate: Mon\n\nbody")).toBeNull();
    expect(splitQuotedText("FYI\n\nFrom: Ada <a@x.org>\nSent: Monday\nSubject: FW: deck\n\nbody")).toBeNull();
  });
  test("a message that is all quote is left alone", () => {
    expect(splitQuotedText("On Mon, Ada <a@x.org> wrote:\n> hi")).toBeNull();
  });
});

describe("newContent", () => {
  test("drops trail, signature and forwards", () => {
    expect(newContent("Yes.\n\nFrom: Ada <a@x.org>\nSent: Mon\n\nold")).toBe("Yes.");
    expect(newContent("Yes.\n-- \nsig")).toBe("Yes.");
    expect(newContent("See below\n———— Forwarded message ————\nstuff")).toBe("See below");
  });
});

describe("writtenPart", () => {
  test("keeps what was written above the trail", () => {
    expect(writtenPart("\n\nOn it.\n\nNora\n\nOn Wed, Apr 29, 2026 at 6:14 PM Theo <theo@x.io> wrote:\n> Reproduced.")).toBe("On it.\n\nNora");
  });
  test("a text that is only a quote has nothing written", () => {
    expect(writtenPart("\nOn Sat, May 12, 2018 at 6:13 AM, Ashot <a@x.io> wrote:\n> hello")).toBe("");
  });
  test("a forward is all content", () => {
    const fwd = "FYI\n\n---------- Forwarded message ---------\nFrom: Yeji <y@x.io>\n\nbody";
    expect(writtenPart(fwd)).toBe(fwd);
  });
});

describe("opensForward", () => {
  test("a forward header before any quote is a forward", () => {
    expect(opensForward("FYI\n\n---------- Forwarded message ---------\nFrom: Yeji <y@x.io>")).toBe(true);
  });
  test("a reply quoting a forward is a reply", () => {
    expect(
      opensForward(
        "Thanks!\n\nOn Wed, Apr 29, 2026 at 6:14 PM Theo <theo@x.io> wrote:\n> ---------- Forwarded message ---------\n> From: Yeji <y@x.io>",
      ),
    ).toBe(false);
  });
});
