import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Rule } from "./types.ts";
import { STATE_DIR } from "./paths.ts";

export const SECTION = "## Learned from my corrections";
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const BACKUP_DIR = join(STATE_DIR, "backups", RUN_ID);
const backedUp = new Set<string>();

export interface Change {
  file: string;
  action: "add" | "rewrite" | "remove" | "guard" | "import";
  line: string;
}

/** Adds an import line (e.g. "@AGENTS.md") unless the file already has it. */
function ensureImport(file: string, line: string): boolean {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === line)) return false;
  write(file, current ? current.replace(/\s*$/, "\n\n") + line + "\n" : line + "\n");
  return true;
}

function backup(file: string) {
  if (backedUp.has(file) || !existsSync(file)) return;
  mkdirSync(BACKUP_DIR, { recursive: true });
  copyFileSync(file, join(BACKUP_DIR, file.replace(/[^A-Za-z0-9.]/g, "_")));
  backedUp.add(file);
}

function write(file: string, content: string) {
  backup(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function addUnderSection(file: string, line: string) {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.includes(line)) return;
  const bullet = `- ${line}`;
  let next: string;
  if (current.includes(SECTION)) {
    const i = current.indexOf(SECTION) + SECTION.length;
    const rest = current.slice(i);
    const nextHeading = rest.search(/\n#{1,2} /);
    const end = nextHeading === -1 ? current.length : i + nextHeading;
    next = current.slice(0, end).replace(/\s*$/, "\n") + bullet + "\n" + current.slice(end);
  } else {
    next = (current ? current.replace(/\s*$/, "\n\n") : "") + `${SECTION}\n\n${bullet}\n`;
  }
  write(file, next);
}

function guardFiles(rule: Rule, repoRoot?: string) {
  if (rule.scope === "repo" && repoRoot) {
    return { guards: join(repoRoot, ".claude", "improvemyagent-guards.json"), settings: join(repoRoot, ".claude", "settings.local.json") };
  }
  return { guards: join(STATE_DIR, "guards.json"), settings: join(homedir(), ".claude", "settings.json") };
}

function installGuard(rule: Rule, repoRoot?: string): Change[] {
  const g = rule.guard!;
  const { guards, settings } = guardFiles(rule, repoRoot);
  const list = existsSync(guards) ? JSON.parse(readFileSync(guards, "utf8")) : [];
  if (!list.some((x: any) => x.pattern === g.pattern)) list.push({ id: rule.id, pattern: g.pattern, message: g.message });
  write(guards, JSON.stringify(list, null, 2) + "\n");

  const script = join(STATE_DIR, "guard.mjs");
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "guard", "guard.mjs");
  copyFileSync(src, script);

  const s = existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")) : {};
  const command = `node ${script}`;
  s.hooks ??= {};
  s.hooks.PreToolUse ??= [];
  const present = s.hooks.PreToolUse.some((h: any) => h.hooks?.some((x: any) => x.command === command));
  if (!present) s.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command }] });
  write(settings, JSON.stringify(s, null, 2) + "\n");
  return [
    { file: guards, action: "guard", line: `${g.pattern} → ${g.message}` },
    { file: settings, action: "guard", line: "PreToolUse hook → improvemyagent guard" },
  ];
}

/** Returns what would change, and applies it unless dryRun. */
export function applyRule(rule: Rule, repoRoot: string | undefined, dryRun: boolean): Change[] {
  const changes: Change[] = [];
  if (rule.status === "STALE" && rule.existing) {
    changes.push({ file: rule.existing.file, action: "remove", line: rule.existing.line });
    if (!dryRun) {
      const c = readFileSync(rule.existing.file, "utf8");
      write(rule.existing.file, c.replace(rule.existing.line, "").replace(/\n{3,}/g, "\n\n"));
    }
    return changes;
  }
  if (rule.status === "CONFLICT") return changes;

  for (const file of rule.destinations) {
    if (rule.status === "IGNORED" && rule.existing?.file === file) {
      changes.push({ file, action: "rewrite", line: rule.text });
      if (!dryRun) {
        const c = readFileSync(file, "utf8");
        write(file, c.replace(rule.existing.line, rule.text));
      }
    } else {
      if (existsSync(file) && readFileSync(file, "utf8").includes(rule.text)) continue;
      changes.push({ file, action: "add", line: rule.text });
      if (!dryRun) addUnderSection(file, rule.text);
    }
  }
  for (const b of rule.bridges ?? []) {
    const has = existsSync(b.file) && readFileSync(b.file, "utf8").split("\n").some((l) => l.trim() === b.line);
    if (has) continue;
    changes.push({ file: b.file, action: "import", line: b.line });
    if (!dryRun) ensureImport(b.file, b.line);
  }
  if (rule.guard) {
    if (dryRun) {
      const { guards, settings } = guardFiles(rule, repoRoot);
      changes.push({ file: guards, action: "guard", line: `${rule.guard.pattern} → ${rule.guard.message}` }, { file: settings, action: "guard", line: "PreToolUse hook → improvemyagent guard" });
    } else changes.push(...installGuard(rule, repoRoot));
  }
  if (!dryRun && changes.length) recordLedger(rule, changes);
  return changes;
}

function recordLedger(rule: Rule, changes: Change[]) {
  const file = join(STATE_DIR, "ledger.json");
  const ledger = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  ledger.push({
    id: rule.id,
    title: rule.title,
    text: rule.text,
    repo: rule.repo,
    status: rule.status,
    files: changes.map((c) => c.file),
    evidence: rule.evidence.map((e) => ({ session: e.sessionId, ts: e.ts })),
    verification: rule.verification,
    appliedAt: new Date().toISOString(),
  });
  writeFileSync(file, JSON.stringify(ledger, null, 2));
}

export function backupDir(): string | undefined {
  return backedUp.size ? BACKUP_DIR : undefined;
}

export function rememberNever(title: string) {
  const file = join(STATE_DIR, "never.json");
  const list: string[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  if (!list.includes(title)) list.push(title);
  writeFileSync(file, JSON.stringify(list, null, 2));
}

export function neverList(): string[] {
  const file = join(STATE_DIR, "never.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

