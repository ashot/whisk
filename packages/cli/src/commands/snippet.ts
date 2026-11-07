import type { Command } from "commander";
import { fmt, icons } from "../colors";
import { readConfig } from "../config";
import { MAIL_SNIPPET, MAIL_SNIPPET_DEF, SKILL_DIR, installSnippet, removeSnippet, snippetStale, snippetTargets, writeSkill } from "../snippet";

// The reference agents read. `install` writes a ## Mail section into each
// agent's instruction file on this machine and refreshes it in place on
// later runs; nothing outside that section is touched.

export function registerSnippet(program: Command): void {
  const snippet = program.command("snippet").description("the one-page reference for agents (install into CLAUDE.md and friends)");

  snippet
    .command("install")
    .description(`write or refresh the section in: ${snippetTargets().map((t) => t.label ?? t.filePath).join(", ")}`)
    .action(() => {
      const result = installSnippet();
      const word = result.installed ? "Installed" : result.updated ? "Updated" : "Already current";
      console.log(`${fmt.success(icons.check)} ${word}:`);
      for (const t of snippetTargets()) console.log(`  ${fmt.path(t.label ?? t.filePath)}`);
    });

  snippet
    .command("remove")
    .description("take the section out of every instruction file")
    .action(() => {
      console.log(removeSnippet() ? "Removed." : "Nothing to remove.");
    });

  snippet
    .command("show")
    .description("print the section")
    .action(() => {
      process.stdout.write(MAIL_SNIPPET.trimStart());
    });

  snippet
    .command("skill [dir]")
    .description(`write the same reference as a skill, SKILL.md (default: ${SKILL_DIR})`)
    .action((dir?: string) => {
      console.log(`${fmt.success(icons.check)} Wrote ${fmt.path(writeSkill(dir))}`);
    });

  snippet
    .command("status")
    .description("whether the installed section matches this build")
    .action(() => {
      const enabled = readConfig()[MAIL_SNIPPET_DEF.enabledKey] === true;
      if (!enabled) return console.log(`Not installed. Run ${fmt.cmd("whisk snippet install")}.`);
      console.log(snippetStale() ? fmt.warning("Installed but out of date; run whisk snippet install") : `${fmt.success(icons.check)} Installed and current`);
      for (const t of snippetTargets()) console.log(`  ${fmt.muted(t.label ?? t.filePath)}`);
    });
}
