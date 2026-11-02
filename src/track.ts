// "Did it work?": compares how often a rule's mistake happened before it was
// applied with how often it has happened since, per session in scope.
import type { Baseline, Classified, Session } from "./types.ts";
import type { StoredRule } from "./store.ts";
import { resolveRepo } from "./repo.ts";

export type Verdict = "working" | "not_sticking" | "too_early" | "quiet";

export interface Tracking {
  before: Baseline;
  since: { corrections: number; sessions: number; days: number };
  verdict: Verdict;
}

const DAY = 86_400_000;
export const BASELINE_DAYS = 30;

function inScope(s: Session, rule: Pick<StoredRule, "scope" | "repo">): boolean {
  return rule.scope !== "repo" || resolveRepo(s.cwd).key === rule.repo;
}

/** Sessions in scope with at least one of your messages between from and to. */
export function sessionsBetween(sessions: Session[], rule: Pick<StoredRule, "scope" | "repo">, from: number, to: number): number {
  return sessions.filter((s) => inScope(s, rule) && s.turns.some((t) => t.role === "user" && Date.parse(t.ts) >= from && Date.parse(t.ts) < to)).length;
}

/** Snapshot taken when a rule is suggested and copied onto it when applied. */
export function baselineFor(rule: Pick<StoredRule, "scope" | "repo" | "evidence">, sessions: Session[], now = Date.now()): Baseline {
  const from = now - BASELINE_DAYS * DAY;
  return {
    corrections: rule.evidence.filter((e) => Date.parse(e.ts) >= from).length,
    sessions: sessionsBetween(sessions, rule, from, now),
    days: BASELINE_DAYS,
  };
}

export function track(rule: StoredRule, sessions: Session[], now = Date.now()): Tracking | undefined {
  if (!rule.appliedAt || !rule.baseline) return undefined;
  const applied = Date.parse(rule.appliedAt);
  const since = {
    corrections: rule.evidence.filter((e: Classified) => Date.parse(e.ts) > applied).length,
    sessions: sessionsBetween(sessions, rule, applied, now + 1),
    days: Math.max(0, Math.round((now - applied) / DAY)),
  };
  const before = rule.baseline;
  let verdict: Verdict;
  const beforeRate = before.corrections / Math.max(1, before.sessions);
  const sinceRate = since.corrections / Math.max(1, since.sessions);
  if (since.sessions < 3) verdict = "too_early";
  else if (before.corrections === 0 && since.corrections === 0) verdict = "quiet";
  else if (sinceRate <= beforeRate * 0.5) verdict = since.corrections === 0 && before.corrections <= 1 ? "quiet" : "working";
  else verdict = "not_sticking";
  return { before, since, verdict };
}
