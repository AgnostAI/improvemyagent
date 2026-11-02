import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.IMA_STATE_DIR = mkdtempSync(join(tmpdir(), "ima-state-"));
const { track, baselineFor } = await import("../src/track.ts");
const { mergeEvidence, loadRules, markApplied, markDismissed, saveRules, toStored } = await import("../src/store.ts");

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-31T00:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const session = (id: string, daysAgo: number, cwd = "/nowhere") =>
  ({ tool: "claude-code", id, file: "", cwd, startedAt: iso(daysAgo), turns: [{ role: "user", text: "hi", toolCalls: [], interrupted: false, ts: iso(daysAgo) }] }) as any;
const ev = (id: string, daysAgo: number) => ({ id, ts: iso(daysAgo), sessionId: id, userText: "no", repo: "~" }) as any;

const sessions = [...Array(20)].map((_, i) => session(`s${i}`, 40 - i * 2)); // one every 2 days, 40 → 2 days ago

test("baseline counts corrections and sessions in the 30 days before", () => {
  const b = baselineFor({ scope: "global", evidence: [ev("a", 25), ev("b", 12), ev("c", 45)] } as any, sessions, NOW - 10 * DAY);
  // window is [40d, 10d) ago: a (25d) and b (12d) are in, c (45d) is not; sessions at 40, 38 … 12 days ago
  assert.deepEqual(b, { corrections: 2, sessions: 15, days: 30 });
});

test("working: rate drops by half or more", () => {
  const rule = { scope: "global", appliedAt: iso(10), baseline: { corrections: 10, sessions: 10, days: 30 }, evidence: [ev("x", 5)] } as any;
  const t = track(rule, sessions, NOW)!;
  assert.equal(t.since.sessions, 5);
  assert.equal(t.since.corrections, 1);
  assert.equal(t.verdict, "working");
});

test("not sticking, too early, quiet", () => {
  const base = { scope: "global", baseline: { corrections: 4, sessions: 10, days: 30 } } as any;
  assert.equal(track({ ...base, appliedAt: iso(10), evidence: [ev("1", 9), ev("2", 7), ev("3", 3)] }, sessions, NOW)!.verdict, "not_sticking");
  assert.equal(track({ ...base, appliedAt: iso(3), evidence: [] }, sessions, NOW)!.verdict, "too_early");
  assert.equal(track({ ...base, baseline: { corrections: 0, sessions: 10, days: 30 }, appliedAt: iso(10), evidence: [] }, sessions, NOW)!.verdict, "quiet");
});

test("store: evidence dedupes and stays capped; apply and dismiss persist", () => {
  const merged = mergeEvidence([ev("a", 1)], [ev("a", 1), ev("b", 2), ...[...Array(40)].map((_, i) => ev(`z${i}`, 3 + i))]);
  assert.equal(merged.length, 30);
  assert.equal(merged.filter((e: any) => e.id === "a").length, 1);
  const rule = { id: "r1", title: "t", text: "Do X.", kind: "workflow", scope: "global", status: "NEW", enforcement: "text", destinations: [], bridges: [], evidence: [], rationale: "", score: 0, verification: [], baseline: { corrections: 3, sessions: 9, days: 30 } } as any;
  saveRules([toStored(rule), toStored({ ...rule, id: "r2" })]);
  markApplied(rule, ["/tmp/AGENTS.md"]);
  markDismissed(["r2"]);
  const [a, b] = loadRules();
  assert.equal(a.lifecycle, "applied");
  assert.deepEqual(a.baseline, { corrections: 3, sessions: 9, days: 30 });
  assert.ok(a.appliedAt);
  assert.equal(b.lifecycle, "dismissed");
});
