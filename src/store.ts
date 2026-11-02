// Rules persist across runs in ~/.improvemyagent/rules.json, so a rule keeps its
// wording and identity, new corrections add evidence to it, and applied rules
// can be tracked over time.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Baseline, Classified, Rule } from "./types.ts";
import { STATE_DIR } from "./paths.ts";

export type Lifecycle = "suggested" | "applied" | "dismissed" | "removed";

export interface StoredRule extends Omit<Rule, "destinations" | "bridges" | "verification" | "score"> {
  lifecycle: Lifecycle;
  createdAt: string;
  appliedAt?: string;
  files?: string[];
}

const FILE = () => join(STATE_DIR, "rules.json");
const MAX_EVIDENCE = 30;

export function loadRules(): StoredRule[] {
  try {
    return existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), "utf8")) : [];
  } catch {
    return [];
  }
}

export function saveRules(rules: StoredRule[]) {
  writeFileSync(FILE(), JSON.stringify(rules, null, 1));
}

/** Keeps receipts small but self-contained (Claude Code deletes old logs after ~30 days). */
function slim(e: Classified): Classified {
  const cut = (s: string | undefined, n: number) => (!s ? "" : s.length > n ? s.slice(0, n) + "…" : s);
  return { ...e, agentAction: cut(e.agentAction, 300), agentFix: cut(e.agentFix, 200), priorRequest: cut(e.priorRequest, 300), recentCommands: (e.recentCommands ?? []).slice(-5) };
}

export function mergeEvidence(existing: Classified[], add: Classified[]): Classified[] {
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const e of add) if (!byId.has(e.id)) byId.set(e.id, slim(e));
  return [...byId.values()].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, MAX_EVIDENCE);
}

export function toStored(r: Rule): StoredRule {
  const { destinations, bridges, verification, score, ...rest } = r;
  return { ...rest, evidence: mergeEvidence([], r.evidence), lifecycle: "suggested", createdAt: new Date().toISOString() };
}

export function markApplied(rule: Rule, files: string[]) {
  const rules = loadRules();
  let s = rules.find((x) => x.id === rule.id);
  if (!s) {
    s = toStored(rule);
    rules.push(s);
  }
  s.lifecycle = "applied";
  s.appliedAt = new Date().toISOString();
  s.files = files;
  s.baseline = rule.baseline;
  saveRules(rules);
}

export function markDismissed(ids: string[]) {
  const rules = loadRules();
  for (const r of rules) if (ids.includes(r.id)) r.lifecycle = "dismissed";
  saveRules(rules);
}

/** Lesson ids already considered for new rules, so later runs only look at new ones. */
const SEEN = () => join(STATE_DIR, "seen.json");

export function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(SEEN(), "utf8")));
  } catch {
    return new Set();
  }
}

export function saveSeen(ids: string[]) {
  writeFileSync(SEEN(), JSON.stringify([...new Set(ids)]));
}

const NO_MATCH = () => join(STATE_DIR, "no-match.json");

export function loadNoMatch(rulesKey: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(NO_MATCH(), "utf8"));
    return raw.rulesKey === rulesKey ? new Set(raw.ids) : new Set();
  } catch {
    return new Set();
  }
}

export function saveNoMatch(rulesKey: string, ids: string[]) {
  writeFileSync(NO_MATCH(), JSON.stringify({ rulesKey, ids: [...new Set(ids)] }));
}

export type { Baseline };
