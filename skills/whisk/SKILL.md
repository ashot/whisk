---
name: whisk
description: Read, search, send, reply to and triage the human's Gmail from the terminal with the whisk CLI. Use whenever a task touches their email, such as finding a message, answering or sending one, waiting on a reply, or cleaning up the inbox.
---

# Mail with whisk

If `whisk status` says this terminal is not signed in, ask the human to run
`whisk auth`, which signs it in through the browser.

`whisk` is your human's mailbox from the terminal: every connected Gmail
account, read and write, the same backend the Whisk app uses. Use it whenever
a task touches their email: find a message, answer one, send one, clean up.
Reads are silent (nothing is marked read, nothing moves) so look freely; a
write goes to Gmail within seconds and the human sees it in their inbox. Send,
trash and permanent delete are theirs to authorize, so before mail leaves in
their name, make sure they asked for it. Ids are Gmail thread ids; a message
id works wherever a thread id does.

Reads reach the whole mailbox, as far back as it goes: `-n` on `ls` and
`search` has no cap, and whatever Whisk has not synced yet comes from Gmail.
A big sweep (every thread in Sent, a year of one sender) is one command with a
large `-n`; Gmail's per-user quota paces it at a few threads a second, so let
it run rather than splitting it up. Lanes, topics, later and waiting are
Whisk's own views and cover the synced mail. When a read fails, the error says
why.

Whenever you send mail whose answer the work is waiting on, subscribe in the
same step, so the reply wakes this session instead of you polling, sleeping or
leaving the human to tell you it came. `whisk subscribe <thread-id>` watches
the thread `whisk send --wait` printed; an address watches everything that
sender writes. Each new email wakes the session with your `--note` and the
command that reads it. Checks run every 5 minutes and cost nothing until mail
arrives; end the subscription once you have what you needed, or it lapses
after 7 days. `whisk followup` is a different thing: it returns the thread to
the human's inbox.

```bash
# Orientation
whisk status                       # accounts, sync state, writes still on the way
whisk ls                           # inbox, newest first (-n 500, --unread, --since 3d, --from ada)
whisk ls starred|sent|archive|trash|later|waiting
whisk ls newsletters               # a lane: newsletters, notifications, receipts, travel, calendar, promotions, security, social, primary
whisk ls label:Clients             # a Gmail label
whisk lanes                        # inbox counts per lane
whisk search "from:ada has:attachment newer_than:7d"   # Gmail query syntax over the whole mailbox (-n 2000)
whisk search --local "invoice"     # instant, projection only (subject, people, snippet)
whisk read <id>                    # the whole thread, quoted trails trimmed (--full keeps them, --json for fields)
whisk read <id> --json | jq '.messages[-1].body_text'
whisk attachments <id>             # list files; whisk attachment <message-id> <n|name> -o ./dir   (download)

# Writing (--from <address>: which mailbox, or which of its send-as addresses)
whisk send --to ada@x.org --subject "Thursday" "Works for me."
whisk send --to a@x.org --cc b@y.org --subject "Notes" --body-file notes.md
whisk send --to a@x.org --subject "Deck" --attach deck.pdf --attach notes.md "Attached."   # files, up to 25 MB total
echo "Ship it." | whisk reply <id>            # answers the last message; --all for reply-all
whisk reply <id> --draft "…"                  # save instead of sending (--attach works here too)
whisk forward <id> --to c@z.org "FYI"         # the message's files go along (--no-files to leave them)
whisk suggest <id> [-i "decline politely"]    # a reply in the human's voice; --draft or --send to act on it
whisk summarize <id>                          # 2 to 4 sentences: what happened, what needs them
whisk rewrite -i "shorter" - < draft.txt
whisk drafts; whisk draft show|send|rm <draft-id>

# Waiting on a reply: wakes this agent session on each new email
whisk subscribe <id|address> --note "what to do with the answer"   # --every 5m, --for 7d
whisk subscriptions; whisk unsubscribe <sub-id|id|address>

# Triage (any number of ids)
whisk archive <id…>   whisk inbox <id…>   whisk trash <id…>   whisk spam <id…>
whisk mark read|unread <id…>   whisk star|unstar <id…>
whisk label add|rm <label> <id…>              # whisk labels lists them
whisk file <lane|primary> <id…>               # teaches a sender rule (--no-remember for one-off)
whisk snooze <when> <id…>                     # 3h, tomorrow, tonight, weekend, "mon 9am", 2026-09-10
whisk followup <when> <id…>                   # nudge back if nobody replies by then
whisk unsnooze <id…>                          # cancels a snooze or a follow-up
whisk delete <id…> --yes                      # permanent, no trash

# Topics: the inbox as themes (parts of the person's life), each holding topics of one sender's mail
whisk topics                       # every theme, the topics in it, the topics in none; whisk topic show <id|name> lists mail
whisk topic show none              # inbox mail no topic claimed
whisk topic move <id|name|none> <ids…>   # a hand placement Whisk never overrides
whisk topic create "Lease" [ids…]; whisk topic rename <id> "Name" --description "…"
whisk topic file <id> <theme|none>; whisk topic merge <from> <into>; whisk topic dissolve <id>
whisk topic mute|unmute <id>       # mute: archive all of it now and keep new mail in it out of the inbox
whisk topic regroup [--fresh]; whisk topic settings --auto on|off

# Filters: one sentence, judged by a model on new mail; actions are fixed and reviewed
whisk filter preview "Star preschool admissions mail that needs a reply"   # reads and lists matches, changes nothing
whisk filter add "…" [--apply]     # saves for new mail; --apply also runs it on the previewed matches
whisk filters; whisk filter edit|pause|resume|rm <id>; whisk filter run <id> --yes

# Whisk's memory about the human (voice, contacts, filing rules, preferences)
whisk memories; whisk memory add "Prefers short replies" [--contact ada@x.org]; whisk memory rm <id>

# Linking: when you mention a thread to the human, give them the link
whisk link <id…>                   # https://whisk.email/#t/<id>, one per id; opens straight onto the thread
whisk open <id>                    # the same link, opened in the browser (--print for the URL only)

# Every read takes --json (read includes "url"). Writes take --wait to block until Gmail has them.
whisk accounts                     # connected mailboxes; whisk sync pulls new mail now
```
