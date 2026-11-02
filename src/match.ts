// Sorts this run's corrections into rules the developer already has, so known
// problems gather evidence instead of being rewritten as "new" rules each run.
import type { Classified } from "./types.ts";
import type { StoredRule } from "./store.ts";
import { defaultConcurrency, llm, pool } from "./llm.ts";
import { truncate } from "./clean.ts";

const SYSTEM = `You match a developer's corrections of their AI coding agent to an existing list of rules.
For each item, answer with the id of the ONE rule that, if the agent had followed it, would have prevented this correction. Answer "none" if no rule clearly covers it. Be strict: a loosely related rule is "none".
A rule marked (repo X) only applies to items from repo X.`;

const SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, rule: { type: "string" } }, required: ["id", "rule"] } } },
  required: ["items"],
};

/** Returns correction id → rule id for every correction that one of the rules covers. */
export async function matchToRules(items: Classified[], rules: StoredRule[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!items.length || !rules.length) return out;
  const ruleText = rules.map((r) => `[${r.id}] (${r.scope === "repo" ? `repo ${r.repo}` : "global"}) ${r.text}`).join("\n");
  const byId = new Map(rules.map((r) => [r.id, r]));
  const batches: Classified[][] = [];
  for (let i = 0; i < items.length; i += 25) batches.push(items.slice(i, i + 25));
  const results = await pool(batches, defaultConcurrency(), async (batch) => {
    const prompt = `RULES\n${ruleText}\n\nITEMS\n${batch
      .map((c) => `[${c.id}] repo=${c.repo}\n  developer said: "${truncate(c.userText, 300)}"\n  agent had: ${truncate(c.agentAction, 200)}${c.lesson ? `\n  lesson: ${c.lesson}` : ""}`)
      .join("\n")}`;
    try {
      return (await llm<{ items: { id: string; rule: string }[] }>({ system: SYSTEM, prompt, schema: SCHEMA, model: "haiku" })).items;
    } catch {
      return [];
    }
  });
  const itemRepo = new Map(items.map((c) => [c.id, c.repo]));
  for (const m of results.flat()) {
    const rule = byId.get(m.rule);
    if (!rule || !itemRepo.has(m.id)) continue;
    // Never let a repo rule claim evidence from another repo.
    if (rule.scope === "repo" && rule.repo !== itemRepo.get(m.id)) continue;
    out.set(m.id, rule.id);
  }
  return out;
}
