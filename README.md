# improvemyagent

Every time you tell your coding agent "no, use pnpm" or "stop, don't touch the tests", the lesson ends up in a log file on your laptop and nowhere else. The next session makes the same mistake.

**improvemyagent** reads those logs and finds the corrections you keep repeating. It turns them into a few rules for `AGENTS.md` / `CLAUDE.md`, and every rule comes with receipts.

```bash
npx improvemyagent
```

[improvemyagent.com](https://improvemyagent.com)

![Example improvemyagent output](https://unpkg.com/improvemyagent/docs/screenshot.png)

*Example output*

- **Local and private.** The analysis runs on the AI subscription you already have. It checks which of your agents (Claude Code, Codex, Gemini CLI, Cursor CLI, OpenCode, or an `ANTHROPIC_API_KEY`) are logged in, uses the fastest one (Claude first), and switches to another if that one stops working mid-run. No new account, no upload, no telemetry.
- **Works with** Claude Code, Codex, OpenCode, Gemini CLI and Cursor. Sessions in Conductor workspaces are mapped back to your real repos.
- **You approve every line.** Each rule is written once to `AGENTS.md`, and `CLAUDE.md` / `GEMINI.md` just import it.

### Why not just ask the agent to write a CLAUDE.md?

Because AI-written context files tend to make agents *worse*. ETH Zurich found they don't improve task success and add over 20% cost ([Evaluating AGENTS.md, ICLR 2026](https://arxiv.org/abs/2602.11988)). So improvemyagent only proposes rules backed by your own repeated corrections, across separate sessions. Generic advice gets dropped, and `--replay` can test a rule against the real moment you corrected the agent.

## What it does

1. **Reads your sessions** from every agent it finds:
   | Tool | Where it reads |
   |---|---|
   | Claude Code | `~/.claude/projects/*/*.jsonl` |
   | Codex | `~/.codex/sessions/**/rollout-*.jsonl` |
   | OpenCode *(beta)* | `~/.local/share/opencode/storage/` |
   | Gemini CLI *(beta)* | `~/.gemini/tmp/*/chats/session-*.json(l)` |
   | Cursor *(beta)* | `…/Cursor/User/globalStorage/state.vscdb`, read-only |

   Sessions run inside **Conductor** workspaces are mapped back to the main repo using Conductor's own database, so rules land in your real checkout and not in a temporary worktree.
2. **Finds corrections.** It reads every reply you sent after the agent did something (with interrupts and rejected tool calls marked), all at once, and picks out the corrections you keep repeating. With `--deep`, a cheap model labels each reply one by one instead.
3. **Reads everything you already told your agents.** That includes:
   - global and repo `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`, nested ones, `CLAUDE.local.md`, and Cursor rules;
   - Conductor's per-repo custom prompts;
   - `.claude/rules`, Claude's auto-memory files, skills, and settings;
   - facts about the repo: lockfiles, scripts, languages.
4. **Writes a few rules.** It merges repeated lessons and labels each rule:
   - **NEW**: not covered yet;
   - **IGNORED**: already written but still broken, so it rewrites the rule or turns it into a hook;
   - **STALE**: an existing line that contradicts the repo or what you actually asked for;
   - **CONFLICT**: two existing lines that disagree.
   It also picks the right file for each rule.
5. **Verifies.**
   - *Tier A (free):* rules are checked against repo facts. Hooks are tested on your real command history: they must block the commands you corrected and not block your other commands.
   - *Tier B (`--replay n`):* it rewinds to a real moment before a mistake, in a git worktree at that commit. It asks the agent the same request with and without the rule. A judge compares both answers against your actual correction.
6. **Writes each rule once.** Rules go in `AGENTS.md`, the shared standard that Codex, OpenCode, Cursor and Amp read. Claude Code and Gemini CLI get a one-line import instead of a copy:
   - repo: `AGENTS.md`, plus `@AGENTS.md` in `CLAUDE.md` / `GEMINI.md`
   - global: `~/.codex/AGENTS.md`, plus `@~/.codex/AGENTS.md` in `~/.claude/CLAUDE.md` (OpenCode gets its own copy in `~/.config/opencode/AGENTS.md`, because it can't import other files)
7. **You review each rule.** Changes are small diffs with backups in `~/.improvemyagent/backups`. Repo files are left uncommitted.
8. **Remembers and tracks.** Rules are saved in `~/.improvemyagent/rules.json`, so they keep their wording from run to run. New corrections add evidence to the rule they belong to, and only new problems become new suggestions. For every rule you applied, each run shows whether it worked, using your real sessions:
   ```
   Your rules
     Propose the smallest change that solves the problem… (applied Oct 20)
       ✓ working: 14× in 30 sessions before → 1× in 24 since
   ```
   Verdicts: *working* (the mistake now happens at half the rate or less), *not sticking* (reword it or make it a hook), *too early* (fewer than 3 sessions since), or *hasn't come up*.

## Options

```
--since 30d      how far back to read (default 60d)
--replay 3       replay-verify the top 3 rules (costs tokens)
--report         print the report only, never write
--apply 1,3      apply these rule numbers from the last report (or `--apply all`)
--yes            apply everything
--max 6          rules to show
--skip cursor    skip some tools' sessions (claude, codex, opencode, gemini, cursor)
--backend codex  force which agent runs the analysis (default: auto-detect)
-v, --verbose    show the evidence and checks behind each suggestion
--deep           slower, more thorough pass (also finds stale/conflicting lines)
```

## FAQ

**How long does it take?** About 8 seconds for ~1,000 messages with a Claude login; the first rule shows up in about 4. It reads every reply in one go and streams the rules as they're written (two parallel calls, one for how you like agents to work, one for product and code specifics). With an `ANTHROPIC_API_KEY` it's about 6 seconds. Codex can't stream and has a ~7 s floor per request on ChatGPT plans, so it gets one call over your 250 most recent replies (usually 10–15 seconds). `--deep` labels every reply one by one first: slower (about a minute), and it also flags stale or conflicting lines in your existing files.

**What does it cost?** It uses the plan behind the agent you already have (Claude, ChatGPT, Gemini, Cursor). At Claude API prices, a full first run is about $0.30.

**What gets sent to the model?** Short excerpts of your messages and the agent's actions, after a secret scanner removes keys, tokens and passwords. Calls go only to the provider your CLI already uses.

**Can it break my setup?** Nothing is written until you approve it. Every edited file is backed up in `~/.improvemyagent/backups`, and repo files are left uncommitted.

## As a skill

There is also an `improvemyagent` skill that lets your agent run the report, walk you through it in the conversation, and apply the rules you pick.

- **Claude Code:**
  ```
  /plugin marketplace add ShubhamPalriwala/improvemyagent
  /plugin install improvemyagent@improvemyagent
  ```
- **Codex and other agents that read `SKILL.md`:** copy [`skills/improvemyagent`](skills/improvemyagent) into your skills folder (for Codex, `~/.codex/skills/`).

## Hooks

When a rule forbids a specific shell command, for example `npm` in a pnpm repo, a sentence in CLAUDE.md is easy to ignore. improvemyagent can install a `PreToolUse` hook (`~/.improvemyagent/guard.mjs`) that blocks the command and tells the agent what to do instead. Patterns live in `.claude/improvemyagent-guards.json`.

## Privacy

- Excerpts are run through a secret scanner before any model call.
- Rules are never written with secrets in them.
- There is no telemetry.
- State lives in `~/.improvemyagent/`.

---

Built by [Agnost AI](https://agnost.ai). The same engine runs on production agents.
