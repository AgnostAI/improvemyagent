// --weekly: run the report quietly every Monday morning. When it finds something
// new, your next Claude Code session opens with one line about it (no pop-ups),
// and nothing is ever applied without you.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR } from "./paths.ts";

const LABEL = "ai.agnost.improvemyagent";
const MARK = "# improvemyagent weekly";
const PLIST = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = () => join(STATE_DIR, "weekly.log");
const INBOX = () => join(STATE_DIR, "inbox.json");
const HOOK = () => join(STATE_DIR, "inbox-hook.mjs");
const SETTINGS = () => process.env.IMA_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");

/**
 * Pinned to the version that set it up, so a later npm release never runs on
 * your machine unattended. Running --weekly again moves the pin.
 */
export function weeklyCommand(version: string): string {
  return process.env.IMA_WEEKLY_CMD ?? `npx -y improvemyagent@${version} --report --scheduled`;
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

/** What the weekly run found, waiting for the hook to show it once. */
export function leaveNote(message: string) {
  writeFileSync(INBOX(), JSON.stringify({ at: new Date().toISOString(), message }));
}

/** You're looking at the results yourself, so there's nothing left to tell you. */
export function clearNote() {
  rmSync(INBOX(), { force: true });
}

const isOurs = (h: any) => h?.hooks?.some((x: any) => String(x.command ?? "").includes("inbox-hook.mjs"));

/** Adds the SessionStart hook to Claude Code's user settings. Returns false if Claude Code isn't set up. */
export function hookOn(): boolean {
  const file = SETTINGS();
  if (!existsSync(dirname(file))) return false;
  let s: any = {};
  if (existsSync(file)) {
    try {
      s = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return false; // never rewrite a settings file we can't parse
    }
  }
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "guard", "inbox.mjs"), HOOK());
  s.hooks ??= {};
  s.hooks.SessionStart = (s.hooks.SessionStart ?? []).filter((h: any) => !isOurs(h));
  // `|| true`: a missing node never shows up as a hook error in your session.
  s.hooks.SessionStart.push({ matcher: "startup", hooks: [{ type: "command", command: `node "${HOOK()}" 2>/dev/null || true` }] });
  writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  return true;
}

export function hookOff() {
  const file = SETTINGS();
  if (existsSync(file)) {
    try {
      const s = JSON.parse(readFileSync(file, "utf8"));
      const list = s.hooks?.SessionStart;
      if (Array.isArray(list) && list.some(isOurs)) {
        s.hooks.SessionStart = list.filter((h: any) => !isOurs(h));
        if (!s.hooks.SessionStart.length) delete s.hooks.SessionStart;
        if (!Object.keys(s.hooks).length) delete s.hooks;
        writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
      }
    } catch {}
  }
  rmSync(HOOK(), { force: true });
  clearNote();
}

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
  hookOff();
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
