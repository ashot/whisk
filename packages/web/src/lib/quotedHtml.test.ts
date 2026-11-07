import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { splitQuotedHtml } from "./quotedHtml";

function docOf(html: string): Document {
  const window = new Window();
  (globalThis as any).Node ??= window.Node;
  const doc = window.document as unknown as Document;
  doc.body.innerHTML = html;
  return doc;
}

const text = (d: Document) => d.body.textContent!.replace(/\s+/g, " ").trim();

describe("splitQuotedHtml", () => {
  test("Gmail reply", () => {
    const d = docOf(
      `<div dir="ltr">Thanks guys.</div><br><div class="gmail_quote gmail_quote_container"><div class="gmail_attr">On Wed, Apr 29, 2026 at 6:14 PM Green, Jonathan &lt;jg@amazon.com&gt; wrote:<br></div><blockquote class="gmail_quote"><p>old</p><div class="gmail_quote"><div class="gmail_attr">On Tue, Apr 28, 2026 at 1:00 PM Ada &lt;a@x.org&gt; wrote:</div><blockquote class="gmail_quote">older</blockquote></div></blockquote></div>`,
    );
    const s = splitQuotedHtml(d);
    expect(text(d)).toBe("Thanks guys.");
    expect(d.body.innerHTML.endsWith("<br>")).toBe(false);
    expect(s?.attribution?.name).toBe("Green, Jonathan");
    expect(s?.count).toBe(2);
    expect(s?.quotedHtml).toContain("older");
  });

  test("Outlook desktop reply, header block and blank paragraphs", () => {
    const d = docOf(
      `<div class="WordSection1"><p class="MsoNormal"><o:p>&nbsp;</o:p></p><p class="MsoNormal">Samvit,</p><p class="MsoNormal">Circling back.</p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> Jason Benn &lt;jason@union.app&gt;<br><b>Sent:</b> Wednesday, April 29, 2026 4:12 PM<br><b>To:</b> Samvit<br><b>Subject:</b> RE: intro</p></div></div><p class="MsoNormal">old body</p></div>`,
    );
    const s = splitQuotedHtml(d);
    expect(text(d)).toBe("Samvit,Circling back.");
    expect(d.querySelectorAll("p").length).toBe(2);
    expect(s?.attribution).toEqual({ name: "Jason Benn", date: new Date(2026, 3, 29, 16, 12).getTime() });
    expect(s?.quotedHtml).toContain("old body");
  });

  test("Outlook on the web, rule above the header", () => {
    const d = docOf(
      `<div>New words</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg"><b>From:</b> Ada &lt;a@x.org&gt;<br><b>Sent:</b> Monday, May 4, 2026 9:00 AM<br><b>Subject:</b> Re: x</div><div>old</div>`,
    );
    const s = splitQuotedHtml(d);
    expect(text(d)).toBe("New words");
    expect(d.querySelector("hr")).toBeNull();
    expect(s?.quotedHtml.startsWith("<hr")).toBe(true);
  });

  test("Apple Mail cite with its attribution line", () => {
    const d = docOf(
      `<div>Sure.</div><div><br><blockquote type="cite"><div>On Apr 29, 2026, at 6:14 PM, Jason Benn &lt;j@u.app&gt; wrote:</div></blockquote></div>`.replace(
        `<div><br><blockquote`,
        `<div>On Apr 29, 2026, at 6:14 PM, Jason Benn &lt;j@u.app&gt; wrote:<br></div><blockquote`,
      ),
    );
    const s = splitQuotedHtml(d);
    expect(text(d)).toBe("Sure.");
    expect(s?.attribution?.name).toBe("Jason Benn");
  });

  test("forwards and all-quote messages stay whole", () => {
    const fwd = docOf(
      `<div>FYI</div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Ada</div>body</div>`,
    );
    expect(splitQuotedHtml(fwd)).toBeNull();
    expect(text(fwd)).toContain("body");
    const bare = docOf(`<br><div class="gmail_quote"><div class="gmail_attr">On Mon, Ada wrote:</div>x</div>`);
    expect(splitQuotedHtml(bare)).toBeNull();
  });

  test("no quote", () => {
    expect(splitQuotedHtml(docOf(`<p>hello</p>`))).toBeNull();
  });
});
