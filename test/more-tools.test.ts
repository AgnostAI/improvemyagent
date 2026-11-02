import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "ima-test-"));
const w = (p: string, v: unknown) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
};

before(() => {
  // OpenCode storage tree
  const oc = join(dir, "opencode");
  process.env.IMA_OPENCODE_DIR = oc;
  w(join(oc, "session/p1/ses_1.json"), { id: "ses_1", directory: "/work/app", time: { created: 1_790_000_000_000 } });
  w(join(oc, "session/p1/ses_sub.json"), { id: "ses_sub", parentID: "ses_1", directory: "/work/app", time: { created: 1 } });
  w(join(oc, "message/ses_1/msg_1.json"), { id: "msg_1", role: "user", time: { created: 1_790_000_000_000 } });
  w(join(oc, "part/msg_1/prt_1.json"), { id: "prt_1", type: "text", text: "add a date picker" });
  w(join(oc, "message/ses_1/msg_2.json"), { id: "msg_2", role: "assistant", modelID: "m", time: { created: 1_790_000_001_000 } });
  w(join(oc, "part/msg_2/prt_2.json"), { id: "prt_2", type: "tool", tool: "bash", state: { status: "error", input: { command: "npm i react-datepicker" }, error: "permission rejected by user" } });
  w(join(oc, "message/ses_1/msg_3.json"), { id: "msg_3", role: "user", time: { created: 1_790_000_002_000 } });
  w(join(oc, "part/msg_3/prt_3.json"), { id: "prt_3", type: "text", text: "no, use the existing DatePicker component" });

  // Gemini CLI: one .json and one .jsonl session
  const gm = join(dir, "gemini");
  process.env.IMA_GEMINI_DIR = gm;
  w(join(gm, "proj/.project_root"), "/work/site\n");
  w(join(gm, "proj/chats/session-2026-10-01T10-00-aaaa.json"), {
    sessionId: "g1",
    startTime: "2026-10-01T10:00:00Z",
    messages: [
      { id: "1", type: "user", content: "deploy the preview", timestamp: "2026-10-01T10:00:00Z" },
      { id: "2", type: "gemini", content: "Deploying to prod.", timestamp: "2026-10-01T10:00:05Z", toolCalls: [{ name: "run_shell_command", args: { command: "vercel --prod" }, status: "cancelled" }] },
      { id: "3", type: "info", content: "Request cancelled.", timestamp: "2026-10-01T10:00:06Z" },
      { id: "4", type: "user", content: "stop! never deploy to prod without asking", timestamp: "2026-10-01T10:00:07Z" },
    ],
  });
  w(
    join(gm, "proj/chats/session-2026-10-02T10-00-bbbb.jsonl"),
    [
      { sessionId: "g2", startTime: "2026-10-02T10:00:00Z" },
      { id: "1", type: "user", content: [{ text: "fix the header" }], timestamp: "2026-10-02T10:00:00Z" },
      { id: "2", type: "gemini", content: "Rewrote the whole layout.", timestamp: "2026-10-02T10:00:03Z" },
      { id: "3", type: "user", content: "only the header please", timestamp: "2026-10-02T10:00:04Z" },
    ].map((x) => JSON.stringify(x)).join("\n") + "\n",
  );

  // Cursor state.vscdb
  const cdb = join(dir, "state.vscdb");
  process.env.IMA_CURSOR_DB = cdb;
  const db = new DatabaseSync(cdb);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE composerHeaders (composerId TEXT, value TEXT);");
  const put = db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
  put.run("composerData:c1", JSON.stringify({ createdAt: Date.now(), fullConversationHeadersOnly: [{ bubbleId: "b1" }, { bubbleId: "b2" }, { bubbleId: "b3" }] }));
  put.run("bubbleId:c1:b1", JSON.stringify({ type: 1, text: "rename the util", createdAt: Date.now() }));
  put.run("bubbleId:c1:b2", JSON.stringify({ type: 2, text: "Renaming.", toolFormerData: { name: "run_terminal_cmd", params: JSON.stringify({ command: "git mv a b" }), status: "completed" } }));
  put.run("bubbleId:c1:b3", JSON.stringify({ type: 1, text: "don't use git mv, just edit imports", createdAt: Date.now() }));
  db.prepare("INSERT INTO composerHeaders VALUES (?, ?)").run("c1", JSON.stringify({ workspaceIdentifier: { uri: { fsPath: "/work/lib" } } }));
  db.close();

  // Conductor database
  const cond = join(dir, "conductor.db");
  process.env.IMA_CONDUCTOR_DB = cond;
  const c = new DatabaseSync(cond);
  c.exec("CREATE TABLE repos (id TEXT, name TEXT, root_path TEXT, custom_prompt_general TEXT); CREATE TABLE workspaces (repository_id TEXT, workspace_path TEXT);");
  c.prepare("INSERT INTO repos VALUES (?, ?, ?, ?)").run("r1", "webapp", "/Users/x/src/webapp", "Always use pnpm.");
  c.prepare("INSERT INTO workspaces VALUES (?, ?)").run("r1", "/Users/x/conductor/workspaces/webapp/oslo");
  c.close();
});

test("opencode: user/assistant parts, rejected tool, skips sub-sessions", async () => {
  const { opencodeSessionFiles, parseOpencodeSession } = await import("../src/adapters/opencode.ts");
  const { candidatesFrom } = await import("../src/detect.ts");
  const sessions = opencodeSessionFiles(0).map(parseOpencodeSession).filter(Boolean) as any[];
  assert.equal(sessions.length, 1);
  const [c] = candidatesFrom(sessions);
  assert.equal(c.userText, "no, use the existing DatePicker component");
  assert.deepEqual(c.recentCommands, ["npm i react-datepicker"]);
  assert.ok(c.hardSignals.includes("tool_rejected"));
});

test("gemini: json + jsonl, project root, cancel = interrupt", async () => {
  const { geminiSessionFiles, parseGeminiSession } = await import("../src/adapters/gemini.ts");
  const { candidatesFrom } = await import("../src/detect.ts");
  const sessions = geminiSessionFiles(0).map(parseGeminiSession).filter(Boolean) as any[];
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((s) => s.cwd === "/work/site"));
  const cands = candidatesFrom(sessions);
  const deploy = cands.find((c) => c.userText.startsWith("stop!"))!;
  assert.deepEqual(deploy.hardSignals.sort(), ["interrupted", "tool_rejected"]);
  assert.deepEqual(deploy.recentCommands, ["vercel --prod"]);
  assert.ok(cands.some((c) => c.userText === "only the header please"));
});

test("cursor: bubbles in header order, tool params, cwd from composerHeaders", async () => {
  const { cursorSessions } = await import("../src/adapters/cursor.ts");
  const { candidatesFrom } = await import("../src/detect.ts");
  const [s] = cursorSessions(0);
  assert.equal(s.cwd, "/work/lib");
  const [c] = candidatesFrom([s]);
  assert.equal(c.userText, "don't use git mv, just edit imports");
  assert.deepEqual(c.recentCommands, ["git mv a b"]);
});

test("conductor: workspace → main repo, custom prompts", async () => {
  const { conductorRepoFor } = await import("../src/conductor.ts");
  const r = conductorRepoFor("/Users/x/conductor/workspaces/webapp/oslo/src")!;
  assert.equal(r.root, "/Users/x/src/webapp");
  assert.equal(r.prompts.general, "Always use pnpm.");
  assert.equal(conductorRepoFor("/Users/x/conductor/workspaces/webapp/archived-one")?.name, "webapp");
});

test("targets: AGENTS.md once, imports for Claude/Gemini, copy for OpenCode", async () => {
  const { targetsFor, GLOBAL } = await import("../src/targets.ts");
  const repos = new Map([["webapp", { root: "/r", tools: new Set(["claude-code", "codex", "gemini"]) }]]);
  const repoT = targetsFor({ scope: "repo", repo: "webapp", status: "NEW" } as any, repos, new Set());
  assert.deepEqual(repoT.write, ["/r/AGENTS.md"]);
  assert.deepEqual(repoT.bridges, [{ file: "/r/CLAUDE.md", line: "@AGENTS.md" }, { file: "/r/GEMINI.md", line: "@AGENTS.md" }]);
  const g = targetsFor({ scope: "global", status: "NEW" } as any, repos, new Set(["claude-code", "codex", "opencode"]) as any);
  assert.deepEqual(g.write, [GLOBAL.codex, GLOBAL.opencode]);
  assert.deepEqual(g.bridges, [{ file: GLOBAL.claude, line: "@~/.codex/AGENTS.md" }]);
  assert.ok(homedir());
});
