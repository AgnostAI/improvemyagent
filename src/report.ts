import { homedir } from "node:os";
import pc from "picocolors";
import type { Classified, Rule } from "./types.ts";
import type { Tracking } from "./track.ts";
import { truncate } from "./clean.ts";
import { badge } from "./verify.ts";

const HOME = homedir();
export const tilde = (p: string) => (p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);
const day = (ts: string) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export interface Stats {
  /** e.g. "20 Claude Code + 28 Codex" */
  tools: string;
  messages: number;
  corrections: number;
  preferences: number;
  interrupts: number;
  rejections: number;
  instructionFiles: number;
  days: number;
}

const STATUS_COLOR: Record<string, (s: string) => string> = {
  NEW: pc.green,
  IGNORED: pc.yellow,
  STALE: pc.magenta,
  CONFLICT: pc.red,
};

function quotes(evidence: Classified[], n: number): Classified[] {
  // Evidence arrives ordered by how clearly it shows the rule; skip duplicate quotes.
  const seen = new Set<string>();
  return evidence.filter((e) => !seen.has(e.userText) && seen.add(e.userText)).slice(0, n);
}

export function renderHeader(s: Stats): string {
  const lines = [
    pc.bold(`Last ${s.days} days · ${s.tools} sessions · ${s.messages} of your messages`),
    `You corrected your agents ${pc.bold(String(s.corrections))} times and stated ${pc.bold(String(s.preferences))} lasting preference${s.preferences === 1 ? "" : "s"}` +
      pc.dim(` (${s.interrupts} interrupts, ${s.rejections} rejected tool calls)`),
    pc.dim(`Read ${s.instructionFiles} instruction/memory/settings files you already have`),
  ];
  return lines.join("\n");
}

export function renderRule(r: Rule, i: number): string {
  const color = STATUS_COLOR[r.status] ?? pc.white;
  const where = r.scope === "repo" ? r.repo ?? "repo" : "all repos";
  const b = badge(r);
  const badgeColor = b.includes("✓") ? pc.green : b.includes("✗") ? pc.red : pc.dim;
  const sessions = new Set(r.evidence.map((e) => e.sessionId)).size;
  const last = r.evidence.map((e) => e.ts).sort().at(-1);
  const out = [
    `${pc.bold(pc.cyan(String(i + 1).padStart(2)))}  ${pc.bold(r.title)}  ${pc.dim("·")} ${where} ${pc.dim("·")} ${color(r.status)}${r.enforcement === "guard" ? pc.dim(" · ") + pc.yellow("hook") : ""} ${pc.dim("·")} ${badgeColor(b)}`,
    `    ${r.text}`,
  ];
  if (r.existing) out.push(pc.dim(`    existing: "${truncate(r.existing.line, 110)}" in ${tilde(r.existing.file)}`));
  if (r.status !== "STALE" && r.status !== "CONFLICT") out.push(pc.dim(`    → ${r.destinations.map(tilde).join(", ")}${r.bridges?.length ? ` (imported by ${r.bridges.map((b) => tilde(b.file)).join(", ")})` : ""}`));
  if (r.guard) out.push(pc.dim(`    hook blocks: /${r.guard.pattern}/`));
  if (r.evidence.length) {
    out.push(pc.dim(`    ${r.evidence.length}× across ${sessions} session${sessions === 1 ? "" : "s"}${last ? ` · last ${day(last)}` : ""}`));
    for (const q of quotes(r.evidence, 3)) {
      const sig = q.hardSignals.length ? pc.yellow(` [${q.hardSignals.join(", ")}]`) : "";
      out.push(`    ${pc.italic(`"${truncate(q.userText, 110)}"`)} ${pc.dim(`· ${day(q.ts)} · ${q.tool === "codex" ? "Codex" : "Claude"}`)}${sig}`);
    }
  }
  out.push(pc.dim(`    why: ${r.rationale}`));
  for (const v of r.verification) out.push(`    ${v.passed ? pc.green("✓") : v.detail.startsWith("skipped") ? pc.dim("–") : pc.yellow("!")} ${pc.dim(`${v.kind}: ${v.detail}`)}`);
  return out.join("\n");
}

export function renderMarkdown(s: Stats, rules: Rule[]): string {
  const lines = [
    `# improvemyagent report`,
    ``,
    `Last ${s.days} days · ${s.tools} sessions · ${s.messages} messages.`,
    `You corrected your agents ${s.corrections} times and stated ${s.preferences} lasting preferences (${s.interrupts} interrupts, ${s.rejections} rejected tool calls).`,
    ``,
  ];
  rules.forEach((r, i) => {
    lines.push(`## ${i + 1}. ${r.title}`, ``, `**${r.status}** · ${r.scope === "repo" ? r.repo : "all repos"} · ${badge(r)}${r.guard ? " · hook" : ""}`, ``, `> ${r.text}`, ``);
    if (r.existing) lines.push(`Existing line: \`${r.existing.line}\` in \`${tilde(r.existing.file)}\``, ``);
    if (r.status !== "STALE" && r.status !== "CONFLICT")
      lines.push(`Writes to: ${r.destinations.map((d) => "`" + tilde(d) + "`").join(", ")}${r.bridges?.length ? ` (imported by ${r.bridges.map((b) => "`" + tilde(b.file) + "`").join(", ")})` : ""}`, ``);
    if (r.guard) lines.push(`Hook blocks: \`/${r.guard.pattern}/\` → ${r.guard.message}`, ``);
    if (r.evidence.length) {
      lines.push(`Evidence (${r.evidence.length}):`);
      for (const q of quotes(r.evidence, 5)) lines.push(`- "${truncate(q.userText, 200)}" (${day(q.ts)}, ${q.tool})`);
      lines.push(``);
    }
    lines.push(`Why: ${r.rationale}`, ``);
    for (const v of r.verification) lines.push(`- ${v.passed ? "✓" : "✗"} ${v.kind}: ${v.detail}`);
    lines.push(``);
  });
  return lines.join("\n");
}

/** Where a file lives, said the way a person would: "~/.claude/CLAUDE.md" or "webapp/AGENTS.md". */
function place(file: string, _r: Rule, roots: Map<string, string | undefined>): string {
  // Nested repos: the deepest root that contains the file wins.
  const hit = [...roots].filter(([, root]) => root && file.startsWith(root + "/")).sort((a, b) => b[1]!.length - a[1]!.length)[0];
  return hit ? `${hit[0]}/${file.slice(hit[1]!.length + 1)}` : tilde(file);
}

function joinAnd(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The one line that tells you what to do with a suggestion. */
export function action(r: Rule, roots: Map<string, string | undefined>): string {
  if (r.status === "STALE" && r.existing) return `remove "${truncate(r.existing.line, 70)}" from ${place(r.existing.file, r, roots)}`;
  if (r.status === "CONFLICT" && r.existing) return `resolve: "${truncate(r.existing.line, 70)}" in ${place(r.existing.file, r, roots)} contradicts another line`;
  const files = r.destinations.map((d) => place(d, r, roots));
  const importers = (r.bridges ?? []).map((b) => place(b.file, r, roots));
  let out =
    r.status === "IGNORED" && r.existing
      ? `already in ${place(r.existing.file, r, roots)} but keeps getting ignored → replace that line with this`
      : `add to ${joinAnd(files)}${importers.length ? ` (${joinAnd(importers)} ${importers.length === 1 ? "imports" : "import"} it)` : ""}`;
  if (r.guard) out += `, plus a hook that blocks it`;
  return out;
}

/** Groups rules that go to the same place, so each destination is said once. */
export function groupByDestination(rules: Rule[], roots: Map<string, string | undefined>): Rule[] {
  const groups = new Map<string, Rule[]>();
  for (const r of rules) {
    const key = r.status === "STALE" || r.status === "CONFLICT" ? `#${r.id}` : action(r, roots);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].flat();
}

/** Short label for where a rule goes: "global AGENTS.md" or "webapp/AGENTS.md". */
export function shortWhere(r: Rule, roots: Map<string, string | undefined>, compact = false): string {
  if ((r.status === "STALE" || r.status === "CONFLICT") && r.existing) return `${r.status === "STALE" ? "remove from" : "conflict in"} ${place(r.existing.file, r, roots)}`;
  if (r.status === "IGNORED" && r.existing) return `rewrite in ${place(r.existing.file, r, roots)}`;
  const file = r.destinations[0];
  if (!file) return "";
  const local = place(file, r, roots);
  let label = local.startsWith("~") || local.startsWith("/") ? `global ${local.split("/").pop()}` : local;
  // In the list, AGENTS.md is said once in the footer; each line just says where.
  if (compact) label = label.replace(/^global AGENTS\.md$/, "global").replace(/\/AGENTS\.md$/, "");
  return r.guard ? `${label} + hook` : label;
}

/** Length of the leading phrase to bold, so each rule can be scanned by its first words. */
function leadLength(text: string): number {
  const m = text.slice(0, 80).search(/[;:,—]| \(|\. /);
  if (m >= 12) return m;
  const words = text.split(" ").slice(0, 4).join(" ");
  return words.length;
}

/**
 * Wraps a rule inside the clack gutter with a hanging indent, bolds its leading
 * phrase, and ends with the tail (count + where) on the last line if it fits.
 */
function hang(label: string, text: string, tail: string): string {
  const width = Math.max(60, Math.min(process.stdout.columns || 100, 130));
  const gutter = pc.gray("│") + "  ";
  const indent = " ".repeat(label.length);
  const room = width - 3 - label.length;
  const lines: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    if (line && (line + " " + w).length > room) {
      lines.push(line);
      line = "";
    }
    line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  const bold = leadLength(text);
  let offset = 0;
  const styled = lines.map((l) => {
    const start = offset;
    offset += l.length + 1;
    if (start >= bold) return l;
    const cut = Math.min(l.length, bold - start);
    return pc.bold(l.slice(0, cut)) + l.slice(cut);
  });
  const tailVisible = tail.replace(/\x1b\[[0-9;]*m/g, "");
  if (tail) {
    if ((lines.at(-1)!.length + 2 + tailVisible.length) <= room) styled[styled.length - 1] += "  " + tail;
    else styled.push(tail);
  }
  return styled.map((l, i) => gutter + (i === 0 ? label : indent) + l).join("\n");
}

/** One numbered rule: bold lead, wrapped under its number, then how often you said it and where it goes. */
export function renderOne(r: Rule, n: number, roots: Map<string, string | undefined>): string {
  const body = r.status === "STALE" || r.status === "CONFLICT" ? r.rationale : r.text;
  const where = shortWhere(r, roots, true);
  const count = r.mentions ?? r.evidence.length;
  const tail = [count ? pc.dim(`${count}×`) : "", where ? pc.cyan(`(${where})`) : ""].filter(Boolean).join(" ");
  return hang(`${n}.`.padEnd(4), body, tail);
}

export function renderCompact(rules: Rule[], roots: Map<string, string | undefined>): string {
  return rules.map((r, i) => renderOne(r, i + 1, roots)).join("\n");
}

const VERDICT: Record<string, (s: string) => string> = {
  working: (s) => pc.green("✓ " + s),
  not_sticking: (s) => pc.yellow("✗ " + s),
  too_early: (s) => pc.dim("· " + s),
  quiet: (s) => pc.dim("· " + s),
};

/** "Did it work?" for each rule you applied: before vs. since, per session. */
export function renderTracked(items: { rule: { text: string; appliedAt?: string }; tracking?: Tracking }[]): string {
  const lines = [pc.bold("Your rules")];
  for (const { rule, tracking: t } of items) {
    const when = rule.appliedAt ? day(rule.appliedAt) : "";
    let verdict: string;
    if (!t) verdict = pc.dim("· no baseline recorded");
    else {
      const b = `${t.before.corrections}× in ${t.before.sessions} sessions before`;
      const n = `${t.since.corrections}× in ${t.since.sessions} since`;
      verdict =
        t.verdict === "working"
          ? VERDICT.working(`working: ${b} → ${n}`)
          : t.verdict === "not_sticking"
            ? VERDICT.not_sticking(`not sticking: ${b} → ${n}. Reword it or make it a hook`)
            : t.verdict === "too_early"
              ? VERDICT.too_early(`too early: ${t.since.sessions} session${t.since.sessions === 1 ? "" : "s"} since you applied it`)
              : VERDICT.quiet(`hasn't come up in ${t.since.sessions} sessions. Keep it, or remove it if it was a one-off`);
    }
    lines.push(`  ${truncate(rule.text, 90)} ${pc.dim(when ? `(applied ${when})` : "")}`, `    ${verdict}`);
  }
  return lines.join("\n") + "\n";
}
