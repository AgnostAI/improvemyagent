// Where a rule is written. AGENTS.md is the shared standard (Codex, OpenCode,
// Cursor, Amp…), so each rule is written once there; tools that use their own
// file get a one-line import pointing at it instead of a duplicate copy.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Rule, Tool } from "./types.ts";

const HOME = homedir();
export const GLOBAL = {
  claude: join(HOME, ".claude", "CLAUDE.md"),
  codex: join(HOME, ".codex", "AGENTS.md"),
  opencode: join(HOME, ".config", "opencode", "AGENTS.md"),
  gemini: join(HOME, ".gemini", "GEMINI.md"),
};

export interface Bridge {
  file: string;
  /** The import line, e.g. "@AGENTS.md". */
  line: string;
}

export interface Targets {
  write: string[];
  bridges: Bridge[];
}

const homeRel = (p: string) => (p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p);

export function targetsFor(rule: Pick<Rule, "scope" | "repo" | "status" | "existing">, repos: Map<string, { root?: string; tools: Set<string> }>, allTools: Set<Tool>): Targets {
  // A rule that rewrites an existing line stays where that line lives.
  if (rule.status === "IGNORED" && rule.existing) return { write: [rule.existing.file], bridges: [] };

  const repo = rule.scope === "repo" && rule.repo ? repos.get(rule.repo) : undefined;
  if (repo?.root) {
    const agents = join(repo.root, "AGENTS.md");
    const bridges: Bridge[] = [];
    if (repo.tools.has("claude-code")) bridges.push({ file: join(repo.root, "CLAUDE.md"), line: "@AGENTS.md" });
    if (repo.tools.has("gemini")) bridges.push({ file: join(repo.root, "GEMINI.md"), line: "@AGENTS.md" });
    return { write: [agents], bridges };
  }

  const canonical = allTools.has("codex") ? GLOBAL.codex : allTools.has("opencode") ? GLOBAL.opencode : allTools.has("gemini") ? GLOBAL.gemini : GLOBAL.claude;
  const write = [canonical];
  // OpenCode can't import other files, so it gets its own copy.
  if (allTools.has("opencode") && canonical !== GLOBAL.opencode) write.push(GLOBAL.opencode);
  const bridges: Bridge[] = [];
  if (allTools.has("claude-code") && canonical !== GLOBAL.claude) bridges.push({ file: GLOBAL.claude, line: `@${homeRel(canonical)}` });
  if (allTools.has("gemini") && canonical !== GLOBAL.gemini) bridges.push({ file: GLOBAL.gemini, line: `@${canonical}` });
  return { write, bridges };
}
