import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractJson, llm, setBackend, available, detectBackend } from "../src/llm.ts";

const SCHEMA = { type: "object", properties: { label: { type: "string" }, note: { type: "string" } }, required: ["label"] };
const answer = 'Sure! Here it is:\n```json\n{"label": "correction", "note": "uses \\"pnpm\\" {braces}"}\n```';

// Stand-ins for each CLI that print that tool's documented output envelope.
const bin = mkdtempSync(join(tmpdir(), "ima-bin-"));
const stub = (name: string, body: string) => {
  const f = join(bin, name);
  writeFileSync(f, `#!/usr/bin/env node\nif (process.argv.includes("--version")) process.exit(0);\nlet input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => { ${body} });\n`);
  chmodSync(f, 0o755);
};
stub("gemini", `process.stdout.write(JSON.stringify({ response: ${JSON.stringify(answer)}, stats: {} }))`);
stub("cursor-agent", `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ${JSON.stringify(answer)} }))`);
stub("opencode", `const t = ${JSON.stringify(answer)}; process.stdout.write([JSON.stringify({type:"step_start"}), JSON.stringify({type:"text", part:{type:"text", text:t.slice(0,20)}}), JSON.stringify({type:"text", part:{type:"text", text:t.slice(20)}})].join("\\n"))`);
process.env.PATH = `${bin}:${process.env.PATH}`;

test("extractJson handles prose, fences, braces inside strings", () => {
  assert.deepEqual(extractJson(answer), { label: "correction", note: 'uses "pnpm" {braces}' });
});

for (const b of ["gemini", "cursor", "opencode"] as const) {
  test(`${b} backend: parses its envelope and validates required keys`, async () => {
    setBackend(b);
    assert.ok(available(b));
    const out = await llm<{ label: string }>({ system: "classify", prompt: `x-${b}`, schema: SCHEMA, noCache: true });
    assert.equal(out.label, "correction");
  });
}

test("anthropic-api backend: structured output via the SDK", async () => {
  let body: any;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      body = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: '{"label":"praise","note":null}' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.ANTHROPIC_API_KEY = "test";
  setBackend("anthropic-api");
  const out = await llm<{ label: string; note?: string }>({ system: "classify", prompt: "y", schema: SCHEMA, model: "haiku", noCache: true });
  server.close();
  assert.equal(out.label, "praise");
  assert.equal("note" in out, false);
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.output_config.format.schema.additionalProperties, false);
});

test("detects the first installed agent", () => {
  assert.ok(detectBackend());
});

test("switches to the next working agent when the current one keeps failing", async () => {
  const { setFallbacks } = await import("../src/llm.ts");
  // A gemini stand-in that always fails, with a working cursor stand-in behind it.
  const broken = mkdtempSync(join(tmpdir(), "ima-broken-"));
  writeFileSync(join(broken, "gemini"), '#!/usr/bin/env node\nif (process.argv.includes("--version")) process.exit(0);\nprocess.stdin.resume(); process.stdin.on("end", () => { console.error("quota exceeded"); process.exit(1); });\n');
  chmodSync(join(broken, "gemini"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${broken}:${oldPath}`;
  const switched: string[] = [];
  setBackend("gemini");
  setFallbacks(["cursor"], (from, to) => switched.push(`${from}->${to}`));
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await llm<{ label: string }>({ system: "s", prompt: `p${i}`, schema: SCHEMA, noCache: true }).catch(() => undefined));
  process.env.PATH = oldPath;
  assert.deepEqual(switched, ["gemini->cursor"]);
  assert.equal(results.at(-1)?.label, "correction");
});

test("near-duplicate rules from the two streams are caught", async () => {
  const { similar } = await import("../src/fast.ts");
  assert.ok(similar("Keep UI minimal and compact with little negative space, using Agnost's brand fonts, colors and design system", "Keep UI minimal and compact with little negative space; avoid adding extra elements, labels or confirmations"));
  assert.ok(!similar("Open PRs to staging with only the requested diff", "Use my Arc browser via computer use for logged-in sites"));
  assert.ok(!similar("Keep UI minimal and compact", "Keep outreach copy short and human, never AI-sounding"));
});
