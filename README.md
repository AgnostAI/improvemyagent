# improvemyagent

Stop telling your agent the same thing twice.

```bash
npx improvemyagent
```

![improvemyagent output](https://improvemyagent.com/demo.png)

It reads the session history your coding agents already keep on your laptop (Claude Code, Codex, OpenCode, Gemini CLI, Cursor), finds the corrections you keep repeating, and turns them into a few rules for `AGENTS.md`. It takes about 8 seconds.

- **Private.** It runs on the agent login you already have. You don't need an API key, nothing is uploaded, and there's no telemetry. Secrets are redacted before anything reaches the model.
- **Grounded.** A rule only shows up if you corrected the same thing in separate sessions. AI-written context files without that grounding tend to make agents worse ([ETH Zurich, 2026](https://arxiv.org/abs/2602.11988)).
- **One file.** Each rule is written once to `AGENTS.md`, and `CLAUDE.md` / `GEMINI.md` import it with `@AGENTS.md`.
- **Tracked.** Run it again later, or turn on `--weekly`, to see whether each rule you applied actually stopped the mistake.

## Apply

```bash
npx improvemyagent --apply 1,3    # or --apply all
```

Nothing is written until you run this. Edited files are backed up to `~/.improvemyagent/backups`, and repo files are left uncommitted.

## As a skill

Let your agent run it and walk you through the rules:

```bash
npx skills add AgnostAI/improvemyagent
```

Or, in Claude Code: `/plugin marketplace add AgnostAI/improvemyagent`, then `/plugin install improvemyagent@improvemyagent`.

## Options

```
--since 30d      how far back to read (default 60d)
--report         only print, never write
--skip cursor    ignore some agents' sessions
--backend codex  pick which agent runs the analysis (default: fastest one you're logged into)
--deep           slower, also flags stale or conflicting lines in your files
--weekly         check in every Monday and notify you when something is new (--weekly off to stop)
```

`npx improvemyagent --help` lists the rest.

---

MIT. Built by [Agnost AI](https://agnost.ai), which does the same for the agents you ship.
