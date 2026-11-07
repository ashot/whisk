import { expect, test } from "bun:test";
import { buildSuggestPrompt, normalizeForMatch, sanitizeSuggestions } from "./suggest";

test("sanitize drops verbatim sent mail, junk, and low confidence", () => {
  const banned = new Set([normalizeForMatch("Thanks for Tuesday.")]);
  const out = sanitizeSuggestions(
    [
      { text: "Thanks for Tuesday.", confidence: 0.99 },
      { text: "Thursday works — I'll send the form today.", confidence: 0.9 },
      { text: "I cannot help with that.", confidence: 0.95 },
      { text: "ok", confidence: 0.4 },
      { text: "See you Thursday.", confidence: 0.8 },
    ],
    banned,
  );
  expect(out).toEqual(["Thursday works — I'll send the form today.", "See you Thursday."]);
});

test("sanitize accepts a bare string list the way a sloppy model might return", () => {
  expect(sanitizeSuggestions(["Hello there, that works."], new Set())).toEqual(["Hello there, that works."]);
});

test("the prompt asks for a prediction in their voice, not a replay of sent mail", () => {
  const prompt = buildSuggestPrompt({
    who: "Ashot <ashot@x.org>",
    subject: "First day",
    transcript: "From: Anna <anna@y.org> (2026-09-16)\nCan we use the old account?",
    sent: ["Hey Anna,\n\nYes, use ashot@x.org.\n\nThanks,\nAshot"],
    style: ["Short. Signs off Thanks, Ashot."],
    preferences: [],
    contacts: ["anna@y.org: preschool admin"],
    signature: "Thanks,\nAshot",
  });
  expect(prompt).toContain("Never replay a past email verbatim");
  expect(prompt).toContain("I was just about to type that");
  expect(prompt).toContain("Hey Anna,");
  expect(prompt).toContain("Can we use the old account?");
});
