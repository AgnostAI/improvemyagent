// Everything the user has already told their agents: instruction files,
// rules, memories, skills and settings, globally and per repo.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstructionFile, Session } from "./types.ts";
import { resolveRepo } from "./repo.ts";
import { redact } from "./clean.ts";
import { conductor } from "./conductor.ts";

const HOME = homedir();

function read(path: string): string | undefined {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readdirIf(dir: string, ext: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => join(dir, f)) : [];
}

function mdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f));
}

function skillSummaries(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const lines: string[] = [];
  for (const name of readdirSync(dir)) {
    const skill = read(join(dir, name, "SKILL.md"));
    if (!skill) continue;
    const desc = skill.match(/^description:\s*(.+)$/m)?.[1] ?? "";
    lines.push(`- ${name}: ${redact(desc).slice(0, 200)}`);
  }
  return lines.length ? lines.join("\n") : undefined;
}

function settingsSummary(path: string): string | undefined {
  const raw = read(path);
  if (!raw) return undefined;
  try {
    const s = JSON.parse(raw);
    return JSON.stringify({ permissions: s.permissions, hooks: s.hooks ? Object.keys(s.hooks) : undefined }, null, 1);
  } catch {
    return undefined;
  }
}

function push(out: InstructionFile[], path: string, kind: string, scope: "global" | "repo", repo?: string, content?: string) {
  const c = content ?? read(path);
  if (c && c.trim()) out.push({ path, kind, scope, repo, content: c });
}

function nestedInstructionFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "--", "*CLAUDE.md", "*AGENTS.md", "*CLAUDE.local.md", "*GEMINI.md"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split("\n")
      .filter(Boolean);
    return out.map((f) => join(root, f));
  } catch {
    return ["CLAUDE.md", "AGENTS.md"].map((f) => join(root, f));
  }
}

export function inventory(sessions: Session[]): InstructionFile[] {
  const out: InstructionFile[] = [];
  push(out, join(HOME, ".claude", "CLAUDE.md"), "claude-global", "global");
  for (const f of mdFiles(join(HOME, ".claude", "rules"))) push(out, f, "claude-global-rule", "global");
  push(out, join(HOME, ".codex", "AGENTS.md"), "codex-global", "global");
  push(out, join(HOME, ".config", "opencode", "AGENTS.md"), "opencode-global", "global");
  push(out, join(HOME, ".gemini", "GEMINI.md"), "gemini-global", "global");
  push(out, join(HOME, ".claude", "settings.json"), "claude-settings", "global", undefined, settingsSummary(join(HOME, ".claude", "settings.json")));
  push(out, join(HOME, ".claude", "skills"), "claude-skills", "global", undefined, skillSummaries(join(HOME, ".claude", "skills")));
  push(out, join(HOME, ".codex", "skills"), "codex-skills", "global", undefined, skillSummaries(join(HOME, ".codex", "skills")));

  const roots = new Map<string, string>();
  const memDirs = new Map<string, string>();
  for (const s of sessions) {
    const ref = resolveRepo(s.cwd);
    if (ref.root && !roots.has(ref.key)) roots.set(ref.key, ref.root);
    const enc = s.cwd.replace(/[^A-Za-z0-9]/g, "-");
    memDirs.set(join(HOME, ".claude", "projects", enc, "memory"), ref.key);
  }
  for (const [repo, root] of roots) {
    const seen = new Set<string>();
    for (const f of [...nestedInstructionFiles(root), join(root, "CLAUDE.local.md"), join(root, "AGENTS.override.md"), join(root, "GEMINI.md"), join(root, ".cursorrules")]) {
      if (seen.has(f)) continue;
      seen.add(f);
      const kind = /AGENTS(\.override)?\.md$/.test(f) ? "agents-md" : f.endsWith("GEMINI.md") ? "gemini-md" : f.endsWith(".cursorrules") ? "cursor-rules" : "claude-md";
      push(out, f, kind, "repo", repo);
    }
    for (const f of readdirIf(join(root, ".cursor", "rules"), ".mdc")) push(out, f, "cursor-rule", "repo", repo);
    const prompts = conductor().byName.get(repo)?.prompts ?? {};
    for (const [name, text] of Object.entries(prompts)) push(out, `conductor:${repo}:${name}`, "conductor-prompt", "repo", repo, text);
    for (const f of mdFiles(join(root, ".claude", "rules"))) push(out, f, "claude-rule", "repo", repo);
    for (const name of ["settings.json", "settings.local.json"]) {
      const p = join(root, ".claude", name);
      push(out, p, "claude-settings", "repo", repo, settingsSummary(p));
    }
  }
  const seenMem = new Set<string>();
  for (const [dir, repo] of memDirs) {
    for (const f of mdFiles(dir)) {
      if (f.endsWith("MEMORY.md") || seenMem.has(f)) continue;
      seenMem.add(f);
      push(out, f, "claude-memory", repo === "~" ? "global" : "repo", repo === "~" ? undefined : repo);
    }
  }
  return out;
}

export function repoRoots(sessions: Session[]): Map<string, string | undefined> {
  const m = new Map<string, string | undefined>();
  for (const s of sessions) {
    const ref = resolveRepo(s.cwd);
    if (!m.has(ref.key) || (!m.get(ref.key) && ref.root)) m.set(ref.key, ref.root);
  }
  return m;
}
