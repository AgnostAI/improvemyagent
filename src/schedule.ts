// --weekly: run the report quietly every Monday morning and save it to
// ~/.improvemyagent/reports. No pop-ups, and nothing is applied without you.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "./paths.ts";

const LABEL = "ai.agnost.improvemyagent";
const MARK = "# improvemyagent weekly";
const PLIST = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = () => join(STATE_DIR, "weekly.log");

/**
 * Pinned to the version that set it up, so a later npm release never runs on
 * your machine unattended. Running --weekly again moves the pin.
 */
export function weeklyCommand(version: string): string {
  return process.env.IMA_WEEKLY_CMD ?? `npx -y improvemyagent@${version} --report`;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Mondays at 10:00. launchd runs a missed slot when the Mac wakes up. */
export function plistFor(cmd: string, path: string, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>${xml(cmd)}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** cron has an empty environment: carry PATH so it can find node and your agent. */
export function cronLine(cmd: string, env: NodeJS.ProcessEnv, log: string): string {
  const path = env.PATH ? `PATH='${env.PATH}' ` : "";
  return `0 10 * * 1 ${path}${cmd} >> '${log}' 2>&1 ${MARK}`;
}

function crontab(): string {
  const r = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}

function setCrontab(lines: string[]) {
  const body = lines.filter((l) => l.trim()).join("\n");
  execFileSync("crontab", ["-"], { input: body ? body + "\n" : "" });
}

const uid = () => String(process.getuid?.() ?? "");

export function weeklyOn(version: string): string {
  const cmd = weeklyCommand(version);
  if (process.platform === "darwin") {
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    spawnSync("launchctl", ["bootout", `gui/${uid()}`, PLIST()], { stdio: "ignore" });
    writeFileSync(PLIST(), plistFor(cmd, process.env.PATH ?? "/usr/bin:/bin", LOG()));
    execFileSync("launchctl", ["bootstrap", `gui/${uid()}`, PLIST()]);
    return "Every Monday at 10:00";
  }
  if (process.platform === "linux") {
    setCrontab([...crontab().split("\n").filter((l) => !l.includes(MARK)), cronLine(cmd, process.env, LOG())]);
    return "Every Monday at 10:00";
  }
  throw new Error("--weekly works on macOS and Linux for now.");
}

export function weeklyOff(): boolean {
  if (process.platform === "darwin") {
    if (!existsSync(PLIST())) return false;
    spawnSync("launchctl", ["bootout", `gui/${uid()}`, PLIST()], { stdio: "ignore" });
    rmSync(PLIST());
    return true;
  }
  if (process.platform === "linux") {
    const lines = crontab().split("\n");
    if (!lines.some((l) => l.includes(MARK))) return false;
    setCrontab(lines.filter((l) => !l.includes(MARK)));
    return true;
  }
  return false;
}

export function weeklyIsOn(): boolean {
  if (process.platform === "darwin") return existsSync(PLIST());
  if (process.platform === "linux") return crontab().includes(MARK);
  return false;
}
