import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.IMA_STATE_DIR = mkdtempSync(join(tmpdir(), "ima-state-"));
const claudeDir = join(mkdtempSync(join(tmpdir(), "ima-claude-")), ".claude");
mkdirSync(claudeDir);
process.env.IMA_CLAUDE_SETTINGS = join(claudeDir, "settings.json");
const { clearNote, cronLine, hookOff, hookOn, leaveNote, plistFor, weeklyCommand } = await import("../src/schedule.ts");

test("weekly runs are pinned to the installed version and only report", () => {
  assert.equal(weeklyCommand("0.2.2"), "npx -y improvemyagent@0.2.2 --report --scheduled");
});

test("launchd plist is valid and runs Mondays at 10:00 with your PATH", () => {
  const plist = plistFor("npx -y improvemyagent@0.2.2 --report", "/opt/homebrew/bin:/usr/bin", "/tmp/w.log");
  assert.match(plist, /<key>Weekday<\/key><integer>1<\/integer><key>Hour<\/key><integer>10<\/integer>/);
  assert.match(plist, /\/opt\/homebrew\/bin:\/usr\/bin/);
  if (process.platform === "darwin") {
    const f = join(mkdtempSync(join(tmpdir(), "ima-plist-")), "x.plist");
    writeFileSync(f, plist);
    assert.equal(spawnSync("plutil", ["-lint", f]).status, 0);
  }
});

test("cron line carries PATH and is tagged for removal", () => {
  const line = cronLine("npx -y improvemyagent@0.2.2 --report", { PATH: "/usr/bin", HOME: "/h" }, "/tmp/w.log");
  assert.equal(line, "0 10 * * 1 PATH='/usr/bin' npx -y improvemyagent@0.2.2 --report >> '/tmp/w.log' 2>&1 # improvemyagent weekly");
});

const settings = () => JSON.parse(readFileSync(process.env.IMA_CLAUDE_SETTINGS!, "utf8"));
const runHook = () => spawnSync("node", [join(process.env.IMA_STATE_DIR!, "inbox-hook.mjs")], { encoding: "utf8", env: process.env }).stdout;

test("SessionStart hook keeps your other settings, installs once, and comes off cleanly", () => {
  const mine = { model: "opus", hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] }], PreToolUse: [{ matcher: "Bash", hooks: [] }] } };
  writeFileSync(process.env.IMA_CLAUDE_SETTINGS!, JSON.stringify(mine));
  assert.equal(hookOn(), true);
  assert.equal(hookOn(), true);
  const s = settings();
  assert.equal(s.model, "opus");
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.match(s.hooks.SessionStart[1].hooks[0].command, /inbox-hook\.mjs" 2>\/dev\/null \|\| true$/);
  hookOff();
  assert.deepEqual(settings(), mine);
  assert.equal(existsSync(join(process.env.IMA_STATE_DIR!, "inbox-hook.mjs")), false);
});

test("an unreadable settings file is never rewritten", () => {
  writeFileSync(process.env.IMA_CLAUDE_SETTINGS!, "{ not json");
  assert.equal(hookOn(), false);
  assert.equal(readFileSync(process.env.IMA_CLAUDE_SETTINGS!, "utf8"), "{ not json");
});

test("the hook shows the weekly note once, as a user-only systemMessage", () => {
  writeFileSync(process.env.IMA_CLAUDE_SETTINGS!, "{}");
  hookOn();
  assert.equal(runHook(), "");
  leaveNote("2 new rules, 1 not sticking");
  assert.deepEqual(JSON.parse(runHook()), { systemMessage: "improvemyagent: 2 new rules, 1 not sticking · npx improvemyagent" });
  assert.equal(runHook(), "");
  leaveNote("1 new rule");
  clearNote();
  assert.equal(runHook(), "");
  hookOff();
});
