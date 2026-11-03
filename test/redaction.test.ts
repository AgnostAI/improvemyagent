import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, Turn } from "../src/types.ts";

const key = ["sk", "-", "aB3cD4eF5gH6jK7mN8pQ9rS0"].join("");
const lower = ["q7m2v9x4r8t1", "n6p3s5w0y2k9"].join("");
const hyphen = ["aB3cD4eF5g", "H6jK7mN8pQ9rS0"].join("-");
const dir = mkdtempSync(join(tmpdir(), "ima-redaction-"));
const capture = join(dir, "received.jsonl");
const originalPath = process.env.PATH;
const originalBase = process.env.ANTHROPIC_BASE_URL;
const originalKey = process.env.ANTHROPIC_API_KEY;
process.env.PATH = `${dir}:${originalPath}`;
process.env.IMA_CACHE_DIR = join(dir, "cache");
process.env.IMA_STATE_DIR = join(dir, "state");
const { redact, truncate } = await import("../src/clean.ts");
const { candidatesFrom } = await import("../src/detect.ts");
const { fastPrompt, startClaudeStream, startCodexStream, startApiStream, FAST_SYSTEM } = await import("../src/fast.ts");
const { llm, setBackend, setFallbacks } = await import("../src/llm.ts");
const { verifyReplay } = await import("../src/verify.ts");
const { synthesize } = await import("../src/synthesize.ts");
const { summarize } = await import("../src/adapters/util.ts");
const { mergeEvidence } = await import("../src/store.ts");
const stub = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
let input = ''; process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  const systemFile = args.find(x => x.startsWith('model_instructions_file='))?.split('=')[1].replaceAll('"', '');
  const schemaFile = args[args.indexOf('--output-schema') + 1];
  appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args, input, system: systemFile ? readFileSync(systemFile, 'utf8') : undefined, schema: args.includes('--output-schema') ? JSON.parse(readFileSync(schemaFile, 'utf8')) : undefined}) + '\\n');
  if (args.includes('retry-model')) {
    const flag = ${JSON.stringify(join(dir, "retried"))};
    if (!existsSync(flag)) { writeFileSync(flag, '1'); process.exit(1); }
  }
  if (args.includes('broken-model')) process.exit(1);
  if (args.includes('-o')) writeFileSync(args[args.indexOf('-o') + 1], args.includes('--output-schema') ? '{"rules":[],"ok":true}' : 'RULE | global | Keep tests focused | 2 | m0,m1');
  if (args.includes('stream-json')) console.log(JSON.stringify({type:'stream_event',event:{delta:{text:'RULE | global | Keep tests focused | 2 | m0,m1\\n'}}}));
  else console.log(JSON.stringify({structured_output:{rules:[],ok:true},response:'{"rules":[],"ok":true}',result:'{"rules":[],"ok":true}',type:'text',part:{text:'{"rules":[],"ok":true}'}}));
});`;
for (const name of ["claude", "codex", "gemini", "cursor-agent", "opencode"]) {
  writeFileSync(join(dir, name), stub);
  chmodSync(join(dir, name), 0o755);
}
after(() => {
  process.env.PATH = originalPath;
  for (const [name, value] of [["ANTHROPIC_BASE_URL", originalBase], ["ANTHROPIC_API_KEY", originalKey]]) {
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});
const received = () => readFileSync(capture, "utf8").trim().split("\n").map(x => JSON.parse(x));
const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const system = "Reply with JSON. The token field is a string. Use placeholders for credentials.";

for (const [name, value] of [["lowercase and digits", lower], ["hyphenated", hyphen], ["quoted JSON", '{"api_key": "' + "short" + "-value" + '"}']]) {
  test(`redacts ${name}`, () => assert.ok(!redact(value!).includes(name === "quoted JSON" ? "short-value" : value!)));
}

test("realistic development identifiers survive", () => {
  const text = [
    "Review commit 0123456789abcdef0123456789abcdef01234567 on feature/session-history.",
    "Use UUID 550e8400-e29b-41d4-a716-446655440000 and sha256 " + "abcdef0123456789".repeat(4),
    "Edit src/session-history-parser-v2.test.ts; install @scope/session-history-parser and react-dom@19.2.0.",
    "Keep additionalProperties and model_reasoning_effort in the JSON schema.",
  ].join("\n");
  assert.equal(redact(text), text);
});

for (const [name, value] of [["comma", "violet" + ",river!42"], ["semicolon", "violet" + ";river!42"], ["prefixed key", key + "!tail"]]) {
  test(`unquoted assignment consumes punctuation: ${name}`, () => {
    const clean = redact("password=" + value + " next");
    assert.equal(clean, "password=[REDACTED] next");
    assert.equal(redact(clean), clean);
  });
}

test("compact unquoted assignments consume trailing delimiters rather than leak fragments", () => {
  for (const suffix of [",", "}", ',name:other}']) {
    assert.equal(redact("{password:" + "violet" + suffix), "{password:[REDACTED]");
  }
});

test("quoted assignments stop at closing quotes", () => {
  for (const value of ["x", "violet" + ",river!42", key + "!tail", 'violet\\"river!42']) {
    assert.equal(redact('{"api_key":"' + value + '","name":"y"}'), '{"api_key":[REDACTED],"name":"y"}');
  }
  assert.equal(redact("password='" + "violet;river!42" + "' name=y"), "password=[REDACTED] name=y");
});

test("JSON number, boolean and null secrets keep neighboring fields", () => {
  for (const value of ["123", "-1.5e3", "true", "null"]) {
    const clean = redact('{"password":' + value + ',"name":"other"}');
    assert.equal(clean, '{"password":[REDACTED],"name":"other"}');
    assert.equal(redact(clean), clean);
  }
  assert.equal(redact('{"password":123,river!42'), '{"password":[REDACTED]');
  assert.equal(redact("password=123,river!42"), "password=[REDACTED]");
  assert.equal(redact('"password":123}river!42'), '"password":[REDACTED]');
  assert.equal(redact('"password":false]river!42'), '"password":[REDACTED]');
  assert.equal(redact('{"password":123}'), '{"password":[REDACTED]}');
});

test("hyphenated development identifiers survive while opaque tokens are redacted", () => {
  for (const value of ["Some-Long-Component-Name-V2", "Feature-Session-History-V2", "feature-session-history-1234", "fix/redact-all-outbound", "feature/Some-Long-Component-Name-V2"]) {
    assert.equal(redact(value), value);
  }
  assert.equal(redact(hyphen), "[REDACTED]");
});

test("redaction is idempotent and preserves neighboring JSON fields", () => {
  const raw = JSON.stringify({ api_key: "short" + "-value", retries: 3, name: "test" });
  const clean = redact(raw);
  assert.equal(redact(clean), clean);
  assert.ok(clean.includes('"retries":3,"name":"test"'));
  assert.equal(redact("password=" + key), "password=[REDACTED]");
  assert.equal(redact(redact("password=" + key)), "password=[REDACTED]");
});

test("redacts before truncation", () => {
  assert.equal(truncate("x ".repeat(60) + key, 130), "x ".repeat(60) + "[REDACTED]");
});

const turn = (role: Turn["role"], text: string, toolCalls: Turn["toolCalls"] = []): Turn => ({ role, text, toolCalls, interrupted: false, ts: "2026-01-01T00:00:00Z" });
function candidate() {
  const session: Session = { tool: "claude-code", id: "synthetic", cwd: dir, file: "", startedAt: "", turns: [
    turn("user", "x ".repeat(195) + key),
    turn("assistant", "x ".repeat(245) + key, [{ name: "Bash", summary: "x ".repeat(65) + key, isError: false, rejected: false }]),
    turn("user", "Please use the existing component instead."),
  ] };
  return candidatesFrom([session])[0];
}
test("candidate action, tool summary and earlier request redact before cutting", () => {
  const c = candidate();
  for (const text of [c.agentAction, c.priorRequest]) assert.ok(!text.includes("sk-"));
});
test("adapter summaries redact before cutting", () => {
  for (const input of ["x ".repeat(75) + key, { details: "x ".repeat(68) + key }]) assert.ok(!summarize(input).includes("sk-"));
});
test("Claude and Codex parser fallback summaries redact before cutting", async () => {
  const { parseClaudeSession } = await import("../src/adapters/claude.ts");
  const { parseCodexSession } = await import("../src/adapters/codex.ts");
  const input = { details: "x ".repeat(68) + key };
  const claudeFile = join(dir, "claude.jsonl");
  writeFileSync(claudeFile, JSON.stringify({ type: "assistant", sessionId: "synthetic", cwd: dir, timestamp: "2026-01-01", message: { content: [{ type: "tool_use", id: "call", name: "custom", input }] } }) + "\n");
  const codexFile = join(dir, "codex.jsonl");
  writeFileSync(codexFile, [
    { type: "session_meta", payload: { id: "synthetic", cwd: dir } },
    { type: "response_item", timestamp: "2026-01-01", payload: { type: "function_call", name: "custom", arguments: JSON.stringify(input), call_id: "call" } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  for (const session of [parseClaudeSession(claudeFile), parseCodexSession(codexFile)]) {
    assert.ok(session);
    assert.ok(!session.turns[0].toolCalls[0].summary.includes("sk-"));
  }
});
test("skill descriptions redact before cutting", () => {
  const home = join(dir, "home");
  const skill = join(home, ".claude", "skills", "example");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "description: " + "x ".repeat(95) + key);
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", 'import { inventory } from "./src/inventory.ts"; console.log(JSON.stringify(inventory([])))'], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.ok(output.includes("[REDACTED]"));
  assert.ok(!output.includes("sk-"));
});
test("stored evidence redacts before cutting", () => {
  const [e] = mergeEvidence([], [{ ...candidate(), label: "correction", durable: true, lesson: "Reuse components", priorRequest: "x ".repeat(145) + key }]);
  assert.ok(!e.priorRequest.includes("sk-"));
});

for (const backend of ["claude", "codex", "gemini", "cursor", "opencode"] as const) {
  test(`${backend}: outbound instructions and future prompt fields are redacted`, async () => {
    setBackend(backend);
    await llm({ system: "System instructions " + key, prompt: fastPrompt({ cands: [], existing: key, saved: [], applied: [], dismissed: [] }) + "\nFuture field: " + lower, schema, noCache: true });
    const call = JSON.stringify(received().at(-1));
    for (const secret of [key, lower]) assert.ok(!call.includes(secret));
    assert.ok(call.includes("[REDACTED]"));
  });
}
test("ordinary system instructions and JSON schemas are preserved", async () => {
  setBackend("claude");
  const s = { ...schema, description: "password: schema example" };
  await llm({ system, prompt: key, schema: s, noCache: true });
  const call = received().at(-1);
  assert.equal(call.args[call.args.indexOf("--system-prompt") + 1], system);
  assert.equal(redact(FAST_SYSTEM), FAST_SYSTEM);
  assert.equal(call.args[call.args.indexOf("--json-schema") + 1], JSON.stringify(s));
});
test("synthesis instruction truncation sends no key fragment", async () => {
  setBackend("claude");
  await synthesize([], { sessions: [], repos: new Map(), files: [{ path: "AGENTS.md", kind: "agents-md", scope: "global", content: "x ".repeat(2995) + key }] });
  assert.ok(!received().at(-1).input.includes("sk-"));
});
test("replay redacts instruction files in system prompts before cutting", async () => {
  setBackend("claude");
  const before = received().length;
  const evidence = { ...candidate(), label: "correction" as const, lesson: "Reuse components", durable: true };
  await verifyReplay({ id: "test", title: "Reuse", text: key, kind: "workflow", scope: "global", status: "NEW", enforcement: "text", destinations: [], bridges: [], evidence: [evidence], rationale: "Repeated", score: 1, verification: [] }, {
    sessions: [], repos: new Map(), files: [{ path: "AGENTS.md", kind: "agents-md", scope: "global", content: "x ".repeat(1995) + key }],
  }, 1);
  const calls = received().slice(before);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.ok(!JSON.stringify(call).includes("sk-"));
});

test("retries and fallback backends receive only redacted prompts", async () => {
  setBackend("claude");
  const before = received().length;
  await llm({ system: key, prompt: lower, schema, model: "retry-model", noCache: true });
  setFallbacks(["cursor"]);
  for (let i = 0; i < 3; i++) await llm({ system: key, prompt: lower, schema, model: "broken-model", noCache: true }).catch(() => {});
  const calls = received().slice(before);
  assert.ok(calls.length >= 9);
  for (const call of calls) for (const secret of [key, lower]) assert.ok(!JSON.stringify(call).includes(secret));
  setFallbacks([]);
});
for (const backend of ["claude", "codex"] as const) {
  test(`${backend} stream redacts system and prompt, including Codex retry`, async () => {
    const before = received().length;
    const stream = backend === "claude" ? startClaudeStream(key) : startCodexStream(key, { model: "broken-model", effort: "low" });
    await stream.run(key + " " + lower, () => {});
    const calls = received().slice(before);
    assert.equal(calls.length, backend === "claude" ? 1 : 2);
    for (const call of calls) for (const secret of [key, lower]) assert.ok(!JSON.stringify(call).includes(secret));
  });
}
test("API structured and streaming calls redact both prompt channels", async () => {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", d => raw += d);
    req.on("end", () => {
      const body = JSON.parse(raw); bodies.push(body);
      const message = { id: "msg_test", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: '{"ok":true}' }], usage: { input_tokens: 1, output_tokens: 1 } };
      if (!body.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(message)); return; }
      res.setHeader("content-type", "text/event-stream");
      const events = [
        { type: "message_start", message: { ...message, content: [], stop_reason: null } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "RULE | global | Test | 2 | m0,m1\n" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.ANTHROPIC_API_KEY = "synthetic";
  try {
    setBackend("anthropic-api");
    await llm({ system: key, prompt: lower, schema, noCache: true });
    await startApiStream(key).run(lower, () => {});
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.equal(body.system, "[REDACTED]");
      assert.equal(body.messages[0].content, "[REDACTED]");
    }
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
