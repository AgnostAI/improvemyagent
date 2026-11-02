import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseClaudeSession } from "../src/adapters/claude.ts";
import { parseCodexSession } from "../src/adapters/codex.ts";
import { candidatesFrom } from "../src/detect.ts";
import { redact, stripInjected } from "../src/clean.ts";

const fx = (f: string) => join(import.meta.dirname, "fixtures", f);

test("claude: strips harness text, catches rejection + interrupt", () => {
  const s = parseClaudeSession(fx("claude.jsonl"))!;
  assert.equal(s.turns[0].text, "add lodash");
  const [c] = candidatesFrom([s]);
  assert.equal(c.userText, "no use pnpm");
  assert.deepEqual(c.hardSignals, ["interrupted", "tool_rejected", "tool_error"]);
  assert.deepEqual(c.recentCommands, ["npm install lodash"]);
  assert.equal(c.priorRequest, "add lodash");
});

test("codex: unwraps exec_command, reads git + aborts", () => {
  const s = parseCodexSession(fx("codex.jsonl"))!;
  assert.equal(s.commit, "abc");
  const [c] = candidatesFrom([s]);
  assert.equal(c.userText, "stop, only run the changed test file");
  assert.deepEqual(c.recentCommands, ["npm test -- --all"]);
  assert.ok(c.hardSignals.includes("interrupted"));
});

test("redaction keeps prose, removes tokens", () => {
  assert.equal(redact("key sk-ant-abcdefghijklmnop1234 ok"), "key [REDACTED] ok");
  assert.equal(redact("password: hunter2"), "password: [REDACTED]");
  assert.equal(redact("see pnpm-lock.yaml and useEffectHookCallback"), "see pnpm-lock.yaml and useEffectHookCallback");
  assert.equal(stripInjected("[Request interrupted by user]"), "");
});
