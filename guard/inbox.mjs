#!/usr/bin/env node
// Claude Code SessionStart hook installed by `improvemyagent --weekly`.
// When the weekly run found something new, shows you one line at the start of
// your next session (systemMessage, so it never enters the agent's context),
// then stays quiet until the next weekly run finds something.
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const inbox = join(process.env.IMA_STATE_DIR ?? join(homedir(), ".improvemyagent"), "inbox.json");
try {
  const { message } = JSON.parse(readFileSync(inbox, "utf8"));
  rmSync(inbox);
  if (message) process.stdout.write(JSON.stringify({ systemMessage: `improvemyagent: ${message} · npx improvemyagent` }));
} catch {}
