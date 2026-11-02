#!/usr/bin/env node
// Claude Code PreToolUse hook installed by improvemyagent.
// Blocks Bash commands that match guards learned from your own corrections.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

function load(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  } catch {
    return [];
  }
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let ev;
  try {
    ev = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  if (ev.tool_name !== "Bash") process.exit(0);
  const command = ev.tool_input?.command ?? "";
  const guards = [...load(join(homedir(), ".improvemyagent", "guards.json"))];
  for (let dir = ev.cwd || process.cwd(); ; dir = dirname(dir)) {
    guards.push(...load(join(dir, ".claude", "improvemyagent-guards.json")));
    if (dirname(dir) === dir) break;
  }
  for (const g of guards) {
    try {
      if (new RegExp(g.pattern).test(command)) {
        process.stderr.write(`Blocked by a rule learned from your corrections: ${g.message}`);
        process.exit(2);
      }
    } catch {}
  }
  process.exit(0);
});
