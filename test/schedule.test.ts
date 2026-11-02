import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.IMA_STATE_DIR = mkdtempSync(join(tmpdir(), "ima-state-"));
const home = mkdtempSync(join(tmpdir(), "ima-home-"));
process.env.IMA_HOME = home;
delete process.env.CODEX_HOME;
const { clearNote, cronLine, hookOff, hookOn, leaveNote, opencodePlugin, plistFor, weeklyCommand } = await import("../src/schedule.ts");

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

const read = (rel: string) => JSON.parse(readFileSync(join(home, rel), "utf8"));
const put = (rel: string, v: unknown) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), typeof v === "string" ? v : JSON.stringify(v));
};
const runHook = (flavor = "user") => spawnSync("node", [join(process.env.IMA_STATE_DIR!, "inbox-hook.mjs"), flavor], { encoding: "utf8", env: process.env }).stdout;

// Your own config in each agent, which must survive on and off untouched.
const MINE = {
  ".claude/settings.json": { model: "opus", hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] }], PreToolUse: [{ matcher: "Bash", hooks: [] }] } },
  ".codex/hooks.json": { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] } },
  ".gemini/settings.json": { theme: "dark" },
  ".cursor/hooks.json": { version: 1, hooks: { sessionStart: [{ command: "echo cursor" }] } },
};

test("hooks go into every installed agent, keep your config, and come off cleanly", () => {
  for (const [rel, v] of Object.entries(MINE)) put(rel, v);
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  hookOn();
  const agents = hookOn(); // twice: still one hook each
  assert.deepEqual(agents, ["Claude Code", "Codex", "Gemini CLI", "Cursor", "OpenCode"]);
  const ourCmd = (list: any[]) => list.flatMap((g) => g.hooks ?? [g]).filter((h: any) => /inbox-hook\.mjs/.test(h.command));
  assert.equal(read(".claude/settings.json").model, "opus");
  assert.equal(ourCmd(read(".claude/settings.json").hooks.SessionStart).length, 1);
  assert.equal(ourCmd(read(".codex/hooks.json").hooks.SessionStart).length, 1);
  assert.equal(read(".gemini/settings.json").theme, "dark");
  assert.match(ourCmd(read(".gemini/settings.json").hooks.SessionStart)[0].command, / user 2>\/dev\/null \|\| true$/);
  assert.match(ourCmd(read(".cursor/hooks.json").hooks.sessionStart)[0].command, / cursor 2>\/dev\/null \|\| true$/);
  assert.equal(existsSync(join(home, ".config/opencode/plugins/improvemyagent-weekly.js")), true);
  hookOff();
  for (const [rel, v] of Object.entries(MINE)) assert.deepEqual(read(rel), v, rel);
  assert.equal(existsSync(join(home, ".config/opencode/plugins/improvemyagent-weekly.js")), false);
  assert.equal(existsSync(join(process.env.IMA_STATE_DIR!, "inbox-hook.mjs")), false);
});

test("agents you don't have are left alone, and unreadable configs are never rewritten", () => {
  const bare = mkdtempSync(join(tmpdir(), "ima-bare-"));
  process.env.IMA_HOME = bare;
  mkdirSync(join(bare, ".claude"));
  writeFileSync(join(bare, ".claude", "settings.json"), "{ not json");
  assert.deepEqual(hookOn(), []);
  assert.equal(readFileSync(join(bare, ".claude", "settings.json"), "utf8"), "{ not json");
  assert.equal(existsSync(join(bare, ".codex")), false);
  hookOff();
  process.env.IMA_HOME = home;
});

test("the note shows once: as a message to you, or via the agent in Cursor", () => {
  hookOn();
  assert.equal(runHook(), "");
  leaveNote("2 new rules, 1 not sticking");
  assert.deepEqual(JSON.parse(runHook()), { systemMessage: "improvemyagent: 2 new rules, 1 not sticking · npx improvemyagent" });
  assert.equal(runHook(), "");
  leaveNote("1 new rule");
  assert.match(JSON.parse(runHook("cursor")).additional_context, /^Start your first reply with this one line.*"improvemyagent: 1 new rule · npx improvemyagent"$/);
  leaveNote("1 new rule");
  clearNote();
  assert.equal(runHook(), "");
  hookOff();
});

test("the OpenCode plugin is valid JavaScript", () => {
  const f = join(mkdtempSync(join(tmpdir(), "ima-oc-")), "plugin.mjs");
  writeFileSync(f, opencodePlugin("/tmp/inbox.json"));
  assert.equal(spawnSync("node", ["--check", f]).status, 0);
});
