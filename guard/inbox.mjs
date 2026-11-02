#!/usr/bin/env node
// Session-start hook installed by `improvemyagent --weekly` (Claude Code, Codex,
// Gemini CLI, Cursor). When the weekly run found something new, shows one line at
// the start of your next session, then stays quiet until the next weekly run
// finds something. `user`: a message to you that never enters the agent's
// context. `cursor`: Cursor's hook can only talk to the agent, so it asks the
// agent to pass the line on.
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const inbox = join(process.env.IMA_STATE_DIR ?? join(homedir(), ".improvemyagent"), "inbox.json");
try {
  const { message } = JSON.parse(readFileSync(inbox, "utf8"));
  rmSync(inbox);
  const line = `improvemyagent: ${message} · npx improvemyagent`;
  if (message && process.argv[2] === "cursor") {
    process.stdout.write(JSON.stringify({ additional_context: `Start your first reply with this one line for the user, verbatim, then continue normally: "${line}"` }));
  } else if (message) {
    process.stdout.write(JSON.stringify({ systemMessage: line }));
  }
} catch {}
