import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Classified, InstructionFile, RepoFacts, Rule, Session } from "./types.ts";
import { llm } from "./llm.ts";
import { truncate } from "./clean.ts";

const HOME = homedir();

const SYSTEM = `You turn a developer's corrections of their AI coding agents into a SHORT list of high-value rules for the agents' instruction files (CLAUDE.md for Claude Code, AGENTS.md for Codex).

You get:
1. LESSONS: each extracted from one moment where the developer corrected the agent or stated a preference, with the developer's own words, what the agent had done, and what the agent did next (usually the behavior the developer wanted).
2. EXISTING: the instruction files, memories, skills and settings the developer already has.
3. REPOS: facts about each repo (package manager, scripts, languages) and which agent tools are used there.

Produce rules:
- Merge lessons that express the same underlying rule. Cite every supporting lesson id in "evidence", ordered so the lessons that most clearly show THIS rule's mistake come first (the first 3 are shown to the developer as receipts and the first is replayed as a test).
- Prefer rules backed by 2+ lessons from different moments. A single lesson is only enough if it is clearly a durable, costly or safety-relevant preference.
- Each rule is ONE behavior, at most 30 words, written as an instruction to the agent. Split compound rules; drop the weaker half rather than listing many things. No vague advice ("be careful", "write clean code").
- Corrections that all come from a single session are usually about that one task. Keep them only if they clearly describe a lasting preference.
- Drop anything that was really a one-off task instruction, or that any competent agent already does by default.
- Specific beats generic. The best rules capture something about THIS developer or repo that an agent could not guess: named tools, sources of truth, workflows, taste, things they keep re-explaining. Generic engineering advice ("verify before claiming", "keep it simple") is only worth a rule when the lessons show a distinctive, repeated pattern; then make it as specific as the evidence allows (say what kind of overbuilding, which material gets skipped).
- No two rules may overlap. If two candidate rules would be fixed by the same instruction, merge them.
- scope "repo" if it depends on the repo (tools, commands, conventions, product facts); "global" if it is about how the developer likes to work with agents in general (communication style, autonomy, workflow).
- status:
  - "NEW": not covered by EXISTING.
  - "IGNORED": EXISTING already says this but the agent kept violating it (lessons show violations). Quote the existing line exactly in existing.line and its file in existing.file. Rewrite the rule so it is harder to miss.
- Also review EXISTING and add entries with status:
  - "STALE": an existing line contradicted by REPOS facts or by what the developer actually asked for in LESSONS. Quote it exactly.
  - "CONFLICT": two existing lines that contradict each other. Quote one in existing.line and mention the other in rationale.
  Only do this when clearly justified; evidence may be empty for STALE/CONFLICT backed only by repo facts.
- enforcement "guard" ONLY when the rule forbids a specific shell command pattern that can be blocked mechanically (e.g. using npm in a pnpm repo, force-pushing, running a destructive command). Then give guard.pattern: a JavaScript regex matched against the full bash command that matches the forbidden commands and NOT legitimate ones, and guard.message telling the agent what to do instead. Otherwise enforcement "text".
- For repo rules, set "repo" to the repo key from REPOS.
- Rank by usefulness to the developer (frequency, recency, frustration, time wasted). Return at most 12 entries.
- rationale: one sentence on why, referencing what kept happening.`;

const SCHEMA = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          text: { type: "string" },
          kind: { type: "string", enum: ["convention", "command", "workflow", "communication", "safety"] },
          scope: { type: "string", enum: ["global", "repo"] },
          repo: { type: "string" },
          status: { type: "string", enum: ["NEW", "IGNORED", "STALE", "CONFLICT"] },
          enforcement: { type: "string", enum: ["text", "guard"] },
          guard: { type: "object", properties: { pattern: { type: "string" }, message: { type: "string" } }, required: ["pattern", "message"] },
          existing: { type: "object", properties: { file: { type: "string" }, line: { type: "string" } }, required: ["file", "line"] },
          evidence: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
        },
        required: ["title", "text", "kind", "scope", "status", "enforcement", "evidence", "rationale"],
      },
    },
  },
  required: ["rules"],
};

interface Out {
  rules: (Omit<Rule, "id" | "evidence" | "score" | "verification" | "guard" | "destinations" | "bridges"> & { evidence: string[]; guard?: { pattern: string; message: string } })[];
}

export interface Context {
  sessions: Session[];
  files: InstructionFile[];
  repos: Map<string, { root?: string; facts: RepoFacts; tools: Set<string> }>;
}

/** Repo rules belong to the repo most of their evidence came from. */
function majorityRepo(evidence: Classified[], ctx: Context): string | undefined {
  const counts = new Map<string, number>();
  for (const e of evidence) if (ctx.repos.has(e.repo)) counts.set(e.repo, (counts.get(e.repo) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function score(evidence: Classified[]): number {
  const now = Date.now();
  let s = 0;
  for (const e of evidence) {
    const days = Math.max(0, (now - Date.parse(e.ts)) / 86_400_000);
    s += (1 + 0.5 * e.hardSignals.length + (e.label === "correction" ? 0.5 : 0)) * Math.exp(-days / 45);
  }
  const sessions = new Set(evidence.map((e) => e.sessionId)).size;
  return (s + 0.5 * sessions) * (sessions < 2 ? 0.5 : 1);
}

export async function synthesize(lessons: Classified[], ctx: Context, opts: { model?: string; avoid?: string[] } = {}): Promise<Rule[]> {
  const lessonText = lessons
    .map((l) =>
      [
        `[${l.id}] ${l.tool} · repo=${l.repo} · ${l.ts.slice(0, 10)} · ${l.label}${l.hardSignals.length ? " · " + l.hardSignals.join(",") : ""}`,
        `  lesson: ${l.lesson}`,
        `  developer said: "${truncate(l.userText, 260)}"`,
        `  agent had: ${truncate(l.agentAction, 220)}`,
        l.agentFix ? `  agent then: ${truncate(l.agentFix, 160)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
  const existingText =
    ctx.files.map((f) => `=== ${f.path} (${f.kind}, ${f.scope}${f.repo ? ", repo=" + f.repo : ""})\n${truncate(f.content, 6000)}`).join("\n\n") || "(none: the developer has no instruction files)";
  const repoText = [...ctx.repos]
    .map(([key, r]) => `- ${key}: root=${r.root ?? "(not on disk)"} tools=${[...r.tools].join("+")} packageManager=${r.facts.packageManager ?? "?"} lockfiles=${r.facts.lockfiles.join(",") || "-"} languages=${r.facts.languages.join(",") || "?"} scripts=${Object.keys(r.facts.scripts).slice(0, 15).join(",") || "-"}`)
    .join("\n");
  const avoid = opts.avoid?.length ? `\n\nDO NOT SUGGEST (the developer already has these rules or rejected them)\n${opts.avoid.map((a) => "- " + a).join("\n")}` : "";
  const prompt = `REPOS\n${repoText}\n\nEXISTING\n${existingText}\n\nLESSONS (${lessons.length})\n${lessonText}${avoid}`;

  const out = await llm<Out>({ system: SYSTEM, prompt, schema: SCHEMA, model: opts.model ?? "sonnet" });
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const fileContent = new Map(ctx.files.map((f) => [f.path, f.content]));

  const rules: Rule[] = [];
  for (const r of out.rules) {
    const evidence = r.evidence.map((id) => byId.get(id)).filter((x): x is Classified => !!x);
    // Never trust a quoted existing line that isn't actually in the file.
    if (r.existing && !fileContent.get(r.existing.file)?.includes(r.existing.line.trim())) {
      if (r.status !== "NEW") r.status = "NEW";
      delete (r as any).existing;
    }
    if ((r.status === "STALE" || r.status === "CONFLICT") && !r.existing) continue;
    if (r.scope === "repo") {
      const repo = majorityRepo(evidence, ctx) ?? (r.repo && ctx.repos.has(r.repo) ? r.repo : undefined);
      if (repo) r.repo = repo;
      else r.scope = "global";
    }
    const guard = r.enforcement === "guard" && r.guard ? { tool: "Bash" as const, pattern: r.guard.pattern, message: r.guard.message } : undefined;
    rules.push({
      ...r,
      id: createHash("sha1").update(r.title + r.text).digest("hex").slice(0, 8),
      enforcement: guard ? "guard" : "text",
      guard,
      destinations: [],
      bridges: [],
      evidence,
      score: score(evidence) + (r.status === "IGNORED" ? 1 : 0),
      verification: [],
    });
  }
  return rules.sort((a, b) => b.score - a.score);
}

const REFINE_SYSTEM = `You are the final editor of instruction-file rules learned from a developer's corrections of their AI coding agents.
You get candidate rules, each with the developer's own words that support it. Return the final list:
- Merge rules that overlap (one instruction would fix both). Use the merged rule's ids in "from".
- Drop a rule if its quotes don't actually show that problem, if it is generic advice any agent already follows, or if it only applied to one task.
- Give each kept rule a "title": 3-6 plain words saying what to do (it is what the developer scans first).
- Rewrite each kept rule as ONE instruction to the agent: one sentence, at most 25 words, as specific as the quotes allow. No preamble; at most 3 examples in a list.
- If a rule bundles two different behaviors, split it into two rules (both citing the same "from" ids) or keep only the more valuable one.
- Order by how much the rule will save the developer from repeating themselves. Keep at most 7. Fewer, sharper rules are better.
- You may also get EXISTING rules the developer already has. Never repeat them: if a candidate is already covered by an existing rule, leave it out of "rules" and list it in "duplicates" with that existing rule's id.`;

const REFINE_SCHEMA = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        properties: { from: { type: "array", items: { type: "string" } }, title: { type: "string" }, text: { type: "string" } },
        required: ["from", "title", "text"],
      },
    },
    duplicates: {
      type: "array",
      items: { type: "object", properties: { candidate: { type: "string" }, existing: { type: "string" } }, required: ["candidate", "existing"] },
    },
  },
  required: ["rules", "duplicates"],
};

/** Second pass with a stronger model: merge overlaps, drop weak or generic rules, sharpen wording. */
export interface Refined {
  rules: Rule[];
  /** New candidates that an existing rule already covers: candidate evidence belongs to that rule. */
  duplicates: { evidence: Classified[]; existingId: string }[];
}

export async function refine(rules: Rule[], ctx: Context, existing: { id: string; text: string }[] = [], model = "sonnet"): Promise<Refined> {
  if (!rules.length || (rules.length === 1 && !existing.length)) return { rules, duplicates: [] };
  const existingText = existing.length ? `EXISTING (do not repeat)\n${existing.map((e) => `[${e.id}] ${e.text}`).join("\n")}\n\nCANDIDATES\n` : "";
  const prompt = existingText + rules
    .map((r) =>
      [
        `[${r.id}] (${r.scope === "repo" ? "repo " + r.repo : "global"}, ${r.status}) ${r.title}: ${r.text}`,
        ...r.evidence.slice(0, 6).map((e) => `   - "${truncate(e.userText, 200)}"`),
      ].join("\n"),
    )
    .join("\n\n");
  let out: { rules: { from: string[]; title: string; text: string }[]; duplicates?: { candidate: string; existing: string }[] };
  try {
    out = await llm({ system: REFINE_SYSTEM, prompt, schema: REFINE_SCHEMA, model });
  } catch {
    return { rules, duplicates: [] };
  }
  const byId = new Map(rules.map((r) => [r.id, r]));
  const existingIds = new Set(existing.map((e) => e.id));
  const duplicates = (out.duplicates ?? [])
    .filter((d) => byId.has(d.candidate) && existingIds.has(d.existing))
    .map((d) => ({ evidence: byId.get(d.candidate)!.evidence, existingId: d.existing }));
  const dupIds = new Set((out.duplicates ?? []).map((d) => d.candidate));
  const refined: Rule[] = [];
  for (const o of out.rules) {
    const parts = o.from.filter((id) => !dupIds.has(id)).map((id) => byId.get(id)).filter((r): r is Rule => !!r);
    if (!parts.length) continue;
    const [first, ...rest] = parts;
    const seen = new Set<string>();
    const evidence = parts.flatMap((p) => p.evidence).filter((e) => !seen.has(e.id) && seen.add(e.id));
    refined.push({
      ...first,
      id: createHash("sha1").update(o.title + o.text).digest("hex").slice(0, 8),
      title: o.title,
      text: o.text,
      evidence,
      // Merging a repo rule with a global one makes it global.
      scope: rest.some((p) => p.scope !== first.scope) ? "global" : first.scope,
      repo: first.scope === "repo" ? majorityRepo(evidence, ctx) ?? first.repo : undefined,
      score: score(evidence) + (first.status === "IGNORED" ? 1 : 0),
    });
  }
  return { rules: refined.length || duplicates.length ? refined : rules, duplicates };
}
