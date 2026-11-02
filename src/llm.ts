// LLM calls go through whatever coding agent the user already has (Claude Code,
// Codex, Gemini CLI, Cursor CLI, OpenCode) in headless mode, or an Anthropic
// API key. No new account, and nothing goes anywhere but their own provider.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "./paths.ts";

export interface LlmCall {
  system: string;
  prompt: string;
  schema: object;
  model?: string;
  /** Working directory; replay runs inside the user's repo. */
  cwd?: string;
  /** Comma-separated tool list; empty means no tools. */
  tools?: string;
  maxTurns?: number;
  /** Reasoning effort; defaults to low for the cheap tier, medium otherwise. */
  effort?: "low" | "medium" | "high";
  /** Skip the on-disk cache (replay samples must be independent). */
  noCache?: boolean;
  salt?: string;
}

export const usage = { calls: 0, cached: 0, costUsd: 0, failures: 0, lastError: "" };

const CACHE_DIR = process.env.IMA_CACHE_DIR ?? join(STATE_DIR, "cache");

function cacheKey(c: LlmCall): string {
  return createHash("sha256")
    // Claude keys stay backend-free so caches from earlier versions keep working.
    .update(JSON.stringify(backend === "claude" ? [c.system, c.prompt, c.schema, c.model, c.tools, c.salt] : [backend, c.system, c.prompt, c.schema, c.model, c.tools, c.salt]))
    .digest("hex");
}

export type Backend = "claude" | "codex" | "gemini" | "cursor" | "opencode" | "anthropic-api";

/** Preference order, fastest first (measured cold: Claude ~2 min, Codex ~3.5 min on 1k messages). */
export const BACKENDS: Backend[] = ["claude", "anthropic-api", "codex", "gemini", "cursor", "opencode"];
const BINARY: Record<Backend, string> = { claude: "claude", codex: "codex", gemini: "gemini", cursor: "cursor-agent", opencode: "opencode", "anthropic-api": "" };
let backend: Backend = "claude";
export function setBackend(b: Backend) {
  backend = b;
}
export function getBackend(): Backend {
  return backend;
}

function runOnce<T>(c: LlmCall, b: Backend = backend): Promise<T> {
  switch (b) {
    case "claude":
      return runClaude<T>(c);
    case "codex":
      return runCodex<T>(c);
    case "anthropic-api":
      return runAnthropicApi<T>(c);
    default:
      return runTextCli<T>(c, b);
  }
}

/**
 * Codex's structured output is strict: every object needs additionalProperties
 * false and every property listed as required, so optional ones become nullable.
 */
function strict(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.type === "array") return { ...schema, items: strict(schema.items) };
  if (schema.type !== "object" || !schema.properties) return schema;
  const req = new Set<string>(schema.required ?? []);
  const properties: Record<string, any> = {};
  for (const [k, v] of Object.entries<any>(schema.properties)) {
    const inner = strict(v);
    properties[k] = req.has(k) ? inner : { anyOf: [inner, { type: "null" }] };
  }
  return { ...schema, properties, required: Object.keys(properties), additionalProperties: false };
}

function dropNulls(v: any): any {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
  return v;
}

function runCodex<T>(c: LlmCall): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ima-codex-"));
  const schemaFile = join(dir, "schema.json");
  const outFile = join(dir, "out.json");
  writeFileSync(schemaFile, JSON.stringify(strict(c.schema)));
  // Cheap tier (classification) runs with low reasoning effort; rule writing gets more.
  const effort = !c.model || c.model === "haiku" ? "low" : "medium";
  const args = ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-c", `model_reasoning_effort="${effort}"`, "--output-schema", schemaFile, "-o", outFile, "-C", c.cwd ?? STATE_DIR, "-"];
  const prompt = `${c.system}\n\n${c.tools ? "You may read files in the working directory, but do not modify anything.\n\n" : "Answer from the text below only; do not run commands.\n\n"}${c.prompt}`;
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(dropNulls(JSON.parse(readFileSync(outFile, "utf8"))) as T);
      } catch {
        reject(new Error(`codex failed (${code}): ${err.slice(-300)}`));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    child.stdin.end(prompt);
  });
}

function runClaude<T>(c: LlmCall): Promise<T> {
  // --bare is the leanest mode, but it only authenticates with an API key and never
  // reads the subscription login, so plain Claude Pro/Max users need the normal mode
  // with their settings, plugins, MCP servers and commands switched off instead.
  const lean = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
    ? ["--bare"]
    : ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"];
  const args = [
    "-p",
    ...lean,
    "--no-session-persistence",
    "--output-format", "json",
    "--model", c.model ?? "haiku",
    "--system-prompt", c.system,
    "--json-schema", JSON.stringify(c.schema),
    "--tools", c.tools ?? "",
  ];
  if (c.maxTurns) args.push("--max-turns", String(c.maxTurns));
  if (c.tools) args.push("--permission-mode", "plan");
  if (process.env.IMA_EFFORT !== "off") args.push("--effort", c.effort ?? (!c.model || c.model === "haiku" ? "low" : "medium"));
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: c.cwd ?? STATE_DIR, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out);
        usage.costUsd += res.total_cost_usd ?? 0;
        if (res.is_error || res.structured_output === undefined) {
          reject(new Error(`claude error: ${res.result ?? res.subtype ?? "no structured output"}`));
          return;
        }
        resolve(res.structured_output as T);
      } catch {
        reject(new Error(`claude failed: ${(err || out).slice(0, 300)}`));
      }
    });
    child.stdin.end(c.prompt);
  });
}

export async function llm<T>(c: LlmCall): Promise<T> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, cacheKey(c) + ".json");
  if (!c.noCache && existsSync(file)) {
    usage.cached++;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }
  usage.calls++;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await runOnce<T>(c);
      consecutiveFailures = 0;
      if (!c.noCache) writeFileSync(file, JSON.stringify(out));
      return out;
    } catch (e) {
      lastErr = e;
      if (process.env.IMA_DEBUG) console.error(`[ima] ${backend} call failed (attempt ${attempt + 1}): ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    }
  }
  usage.failures++;
  usage.lastError = String((lastErr as Error)?.message ?? lastErr).slice(0, 300);
  // Several failures in a row (logged out, usage limit hit…): switch to the next agent that works.
  if (++consecutiveFailures >= 3 && fallbacks.length) {
    const from = backend;
    backend = fallbacks.shift()!;
    consecutiveFailures = 0;
    onSwitch?.(from, backend, usage.lastError);
    return llm<T>(c);
  }
  throw lastErr;
}

let consecutiveFailures = 0;
let fallbacks: Backend[] = [];
let onSwitch: ((from: Backend, to: Backend, why: string) => void) | undefined;

/** Other working agents to fall back to, in order, and a hook to report a switch. */
export function setFallbacks(list: Backend[], notify?: (from: Backend, to: Backend, why: string) => void) {
  // Kept by reference: agents confirmed working later are appended by the caller.
  fallbacks = list;
  onSwitch = notify;
}

/** One tiny real call to see whether an agent is installed AND logged in. */
export async function probe(b: Backend): Promise<string | undefined> {
  if (!available(b)) return "not installed";
  try {
    await runOnce<{ ok: boolean }>(
      { system: "Reply with ok=true.", prompt: "ping", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, model: "haiku", noCache: true },
      b,
    );
    return undefined;
  } catch (e) {
    return String((e as Error)?.message ?? e).slice(0, 200);
  }
}

export async function pool<I, O>(items: I[], limit: number, fn: (item: I, i: number) => Promise<O>, onDone?: () => void): Promise<O[]> {
  const results: O[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      onDone?.();
    }
  });
  await Promise.all(workers);
  return results;
}

export function available(b: Backend): boolean {
  if (b === "anthropic-api") return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return spawnSync(BINARY[b], ["--version"], { stdio: "ignore" }).status === 0;
}

export function detectBackend(): Backend | undefined {
  return BACKENDS.find(available);
}

// ---- Anthropic API key (official SDK, structured outputs) ----

const API_MODELS: Record<string, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };

async function runAnthropicApi<T>(c: LlmCall): Promise<T> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const tier = c.model ?? "haiku";
  const response = await client.messages.create({
    model: API_MODELS[tier] ?? tier,
    max_tokens: 16000,
    system: c.system,
    messages: [{ role: "user", content: c.prompt }],
    output_config: { effort: tier === "haiku" ? "low" : "medium", format: { type: "json_schema", schema: strict(c.schema) } },
  });
  if (response.stop_reason === "refusal") throw new Error("model declined the request");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return dropNulls(JSON.parse(text)) as T;
}

// ---- CLIs without native structured output: ask for JSON, then extract it ----

/** Pulls the first balanced JSON object out of free text (models sometimes wrap it in prose or fences). */
export function extractJson(text: string): any {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON in output");
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("unterminated JSON in output");
}

function checkRequired(schema: any, value: any) {
  for (const key of schema?.required ?? []) if (!(key in (value ?? {}))) throw new Error(`missing "${key}" in output`);
}

function runTextCli<T>(c: LlmCall, b: Backend): Promise<T> {
  const prompt = `${c.system}\n\nDo not run commands or edit files. Reply with ONLY one JSON object that matches this JSON Schema, no prose:\n${JSON.stringify(c.schema)}\n\n${c.prompt}`;
  // These agents may auto-approve tools in headless mode, so they run in an empty scratch directory.
  const dir = mkdtempSync(join(tmpdir(), "ima-run-"));
  const model = c.model && !["haiku", "sonnet", "opus"].includes(c.model) ? c.model : undefined;
  let args: string[];
  let viaStdin = false;
  if (b === "gemini") {
    args = ["-p", "Follow the instructions in the input above.", "--output-format", "json", ...(model ? ["-m", model] : [])];
    viaStdin = true;
  } else if (b === "cursor") {
    args = ["-p", "--output-format", "json", ...(model ? ["--model", model] : []), prompt];
  } else {
    args = ["run", "--format", "json", ...(model ? ["-m", model] : []), prompt];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(BINARY[b], args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      try {
        const text = answerText(out, b);
        const value = dropNulls(extractJson(text));
        checkRequired(c.schema, value);
        resolve(value as T);
      } catch (e) {
        reject(new Error(`${b} failed (${code}): ${(e as Error).message} ${err.slice(-200)}`));
      }
    });
    child.stdin.end(viaStdin ? prompt : "");
  });
}

/** The final answer text from each CLI's JSON envelope. */
function answerText(out: string, b: Backend): string {
  if (b === "gemini") {
    try {
      return JSON.parse(out).response ?? out;
    } catch {
      return out;
    }
  }
  if (b === "cursor") {
    try {
      return JSON.parse(out).result ?? out;
    } catch {
      return out;
    }
  }
  // OpenCode --format json emits one event per line; collect the text parts.
  const texts: string[] = [];
  for (const line of out.split("\n")) {
    try {
      const ev = JSON.parse(line);
      const t = ev.part?.text ?? (ev.type === "text" ? ev.text : undefined);
      if (typeof t === "string") texts.push(t);
    } catch {}
  }
  return texts.length ? texts.join("") : out;
}


/** Parallel calls to run. Full `claude` processes (no API key, so no --bare) use ~200 MB each; 16 measured fastest. */
export function defaultConcurrency(): number {
  if (backend === "claude" && !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) return 16;
  return backend === "anthropic-api" ? 24 : 16;
}
