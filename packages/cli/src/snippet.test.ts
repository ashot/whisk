import { expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { mailSkill } from "./snippet";

test("skills/whisk/SKILL.md is what `whisk snippet skill` writes", () => {
  const checkedIn = fs.readFileSync(path.join(import.meta.dir, "../../../skills/whisk/SKILL.md"), "utf8");
  expect(checkedIn).toBe(mailSkill());
});
