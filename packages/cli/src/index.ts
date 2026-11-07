#!/usr/bin/env bun
import { Command } from "commander";
import { fmt } from "./colors";
import { NotAuthed, errorMessage } from "./client";
import { registerCalendar } from "./commands/calendar";
import { registerAuth } from "./commands/auth";
import { registerRead } from "./commands/read";
import { registerWrite } from "./commands/write";
import { registerTriage } from "./commands/triage";
import { registerTopics } from "./commands/topics";
import { registerSnippet } from "./commands/snippet";
import { registerSubscribe } from "./commands/subscribe";

// whisk: the Whisk mailbox from a terminal. One command per gesture the app
// has, so an agent that can run a shell can do anything its human can do in
// the inbox. Reads never touch state; writes go through the same dispatch
// rail as the web app and reach Gmail within seconds.

const program = new Command()
  .name("whisk")
  .description("Read, search, write and triage your mail from the terminal")
  .version("0.1.0")
  .showHelpAfterError()
  .configureHelp({ sortSubcommands: false })
  .addHelpText(
    "after",
    `
Ids are Gmail thread ids as shown by ${fmt.cmd("whisk ls")}; a message id works wherever a thread id does.
Every read takes ${fmt.cmd("--json")}. Writes take ${fmt.cmd("--wait")} to block until Gmail has them.
Run ${fmt.cmd("whisk snippet show")} for the one-page reference agents get.`,
  );

registerAuth(program);
registerRead(program);
registerWrite(program);
registerTriage(program);
registerSubscribe(program);
registerSnippet(program);
registerTopics(program);
registerCalendar(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof NotAuthed ? error.message : errorMessage(error);
  console.error(fmt.error("error:") + " " + message);
  process.exit(1);
});
