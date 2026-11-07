import { describe, expect, test } from "bun:test";
import { privacyRulesFromPrefs, ruleKey, rulesToCheck, threadPrivacy, type PrivacyRule } from "./privacy";

const medical: PrivacyRule = { id: "p1", text: "Anything medical", revision: 1, created_at: 1 };
const legal: PrivacyRule = { id: "p2", text: "Mail with my lawyer", revision: 3, created_at: 2 };

describe("threadPrivacy", () => {
  test("no rules and no mark: open", () => {
    expect(threadPrivacy({ message_count: 2 }, [])).toBe("open");
  });

  test("a hand mark decides alone, either way", () => {
    expect(threadPrivacy({ message_count: 2, private_mark: true }, [])).toBe("private");
    expect(threadPrivacy({ message_count: 2, private_mark: false, private_hits: ["p1"] }, [medical])).toBe("open");
  });

  test("unread by the model: pending, so agents never see it early", () => {
    expect(threadPrivacy({ message_count: 1 }, [medical])).toBe("pending");
  });

  test("read against every current rule with no hit: open", () => {
    const t = { message_count: 3, private_count: 3, private_checked: [ruleKey(medical), ruleKey(legal)], private_hits: [] };
    expect(threadPrivacy(t, [medical, legal])).toBe("open");
  });

  test("new mail since the read: pending again", () => {
    const t = { message_count: 4, private_count: 3, private_checked: [ruleKey(medical)], private_hits: [] };
    expect(threadPrivacy(t, [medical])).toBe("pending");
    expect(rulesToCheck(t, [medical, legal]).map((r) => r.id)).toEqual(["p1", "p2"]);
  });

  test("a hit stays private after new mail until read again", () => {
    const t = { message_count: 4, private_count: 3, private_checked: [ruleKey(medical)], private_hits: ["p1"] };
    expect(threadPrivacy(t, [medical])).toBe("private");
  });

  test("a new rule needs only itself read; a removed rule's hit no longer counts", () => {
    const t = { message_count: 2, private_count: 2, private_checked: [ruleKey(medical)], private_hits: ["p9"] };
    expect(threadPrivacy(t, [medical, legal])).toBe("pending");
    expect(rulesToCheck(t, [medical, legal]).map((r) => r.id)).toEqual(["p2"]);
    expect(threadPrivacy(t, [medical])).toBe("open");
  });

  test("an edited rule is read again at its new wording", () => {
    const t = { message_count: 2, private_count: 2, private_checked: ["p2:2"], private_hits: [] };
    expect(threadPrivacy(t, [legal])).toBe("pending");
  });
});

describe("privacyRulesFromPrefs", () => {
  test("drops blanks, duplicates and junk", () => {
    const rules = privacyRulesFromPrefs({
      privacy_rules: [{ id: "a", text: " x " }, { id: "a", text: "dup" }, { id: "b", text: "  " }, null, { text: "no id" }],
    });
    expect(rules).toEqual([{ id: "a", text: "x", revision: 1, created_at: 0 }]);
  });
});
