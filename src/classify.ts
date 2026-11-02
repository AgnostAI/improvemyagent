import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate, Classified, Label } from "./types.ts";
import { STATE_DIR } from "./paths.ts";
import { defaultConcurrency, llm, pool } from "./llm.ts";
import { truncate } from "./clean.ts";

const SYSTEM = `This is a fast labeling task: answer directly, without long deliberation.
You analyze transcripts between a developer and their AI coding agent (Claude Code or Codex).
For each item you get: the developer's earlier request, what the agent just did, and the developer's next message.
Decide what the developer's next message is, from the developer's point of view:

- "correction": the developer is pushing back on something the agent did or was about to do (wrong approach, wrong tool, ignored an instruction, did too much/too little, wrong style, misunderstood). Interruptions and rejected tool calls followed by a redirect are corrections.
- "durable_preference": the developer states how things should always be done ("always use pnpm", "never commit without asking", "keep answers short"), even if not reacting to a mistake.
- "one_off_instruction": a new or adjusted instruction that only applies to the current task ("use a formal tone for this email", "now do the settings page").
- "clarification": answering the agent's question or adding missing info.
- "praise": positive feedback.
- "neutral": anything else, including "no it's fine", "no worries", "now do X".

For corrections and durable preferences, write "lesson": ONE short imperative rule that would have prevented the mistake in future sessions, written for the agent. Generalize from the specific case but stay concrete: "Use pnpm, not npm, for installs in this repo" not "Be careful with package managers". If the correction only makes sense for this one task, set durable=false. Otherwise lesson="" and durable=false.
Be strict: most messages are NOT corrections. A message starting with "no" is not automatically a correction.`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string", enum: ["correction", "durable_preference", "one_off_instruction", "clarification", "praise", "neutral"] },
          lesson: { type: "string" },
          durable: { type: "boolean" },
        },
        required: ["id", "label", "lesson", "durable"],
      },
    },
  },
  required: ["items"],
};

interface Out {
  items: { id: string; label: Label; lesson: string; durable: boolean }[];
}

function render(c: Candidate): string {
  return [
    `### item ${c.id}`,
    `earlier request: ${c.priorRequest || "(none)"}`,
    `agent action:\n${c.agentAction || "(no action recorded)"}`,
    c.hardSignals.length ? `signals: ${c.hardSignals.join(", ")}` : "",
    `developer's next message: ${truncate(c.userText, 900)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** On failure, split the batch and retry the halves so one bad item can't sink 20. */
async function classifyBatch(batch: Candidate[]): Promise<Out["items"]> {
  try {
    const out = await llm<Out>({ system: SYSTEM, prompt: batch.map(render).join("\n\n"), schema: SCHEMA, model: "haiku" });
    return out.items;
  } catch {
    if (batch.length <= 2) return [];
    const mid = Math.ceil(batch.length / 2);
    return [...(await classifyBatch(batch.slice(0, mid))), ...(await classifyBatch(batch.slice(mid)))];
  }
}

// Labels are cached per message, so a re-run only classifies what's new, no
// matter how new sessions shift the batches. Changing the prompt resets it.
const LABELS = () => join(STATE_DIR, "labels.json");
const VERSION = createHash("sha1").update(SYSTEM + JSON.stringify(SCHEMA)).digest("hex").slice(0, 8);
type Label3 = { label: Label; lesson: string; durable: boolean };

function loadLabels(): Record<string, Label3> {
  try {
    const raw = JSON.parse(readFileSync(LABELS(), "utf8"));
    return raw.version === VERSION ? raw.labels : {};
  } catch {
    return {};
  }
}

export async function classify(
  cands: Candidate[],
  opts: { batch?: number; concurrency?: number; onProgress?: (done: number, total: number, found: number) => void } = {},
): Promise<Classified[] & { fresh?: number }> {
  const labels = loadLabels();
  const todo = cands.filter((c) => !labels[c.id]);
  let done = 0;
  let found = 0;
  const run = async (list: Candidate[], size: number, countProgress: boolean) => {
    const batches: Candidate[][] = [];
    for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size));
    await pool(batches, opts.concurrency ?? defaultConcurrency(), async (batch) => {
      const items = await classifyBatch(batch);
      const ids = new Set(batch.map((c) => c.id));
      for (const r of items) {
        if (!ids.has(r.id) || labels[r.id]) continue;
        labels[r.id] = { label: r.label, lesson: r.lesson, durable: r.durable };
        if (r.label === "correction" || r.label === "durable_preference") found++;
      }
      if (countProgress) done += batch.length;
      opts.onProgress?.(done, todo.length, found);
    });
  };
  await run(todo, opts.batch ?? 15, true);
  // Models sometimes skip items in a long batch; give those a second, smaller pass.
  const skipped = todo.filter((c) => !labels[c.id]);
  if (skipped.length) await run(skipped, 8, false);
  writeFileSync(LABELS(), JSON.stringify({ version: VERSION, labels }));
  const out = cands.map((c) => {
    const r = labels[c.id];
    return { ...c, label: r?.label ?? "neutral", lesson: r?.lesson ?? "", durable: r?.durable ?? false };
  }) as Classified[] & { fresh?: number };
  out.fresh = todo.length;
  return out;
}
