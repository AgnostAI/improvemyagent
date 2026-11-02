import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.IMA_STATE_DIR = mkdtempSync(join(tmpdir(), "ima-state-"));
const { cronLine, plistFor, weeklyCommand } = await import("../src/schedule.ts");

test("weekly runs are pinned to the installed version and only report", () => {
  assert.equal(weeklyCommand("0.2.2"), "npx -y improvemyagent@0.2.2 --report");
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
