---
name: improvemyagent
description: Read the user's past coding-agent sessions (Claude Code, Codex, OpenCode, Gemini CLI, Cursor), find the corrections they keep repeating, and propose rules for AGENTS.md / CLAUDE.md. Use when the user asks to improve their agent, learn from past sessions, stop repeating themselves, or update their instruction files from experience.
---

# improvemyagent

1. Run `npx -y improvemyagent --report`. It takes about 10 seconds: it reads local session logs and analyzes them with the user's own agent login.
2. Show the numbered rules exactly as printed, with the `N×` count and the destination in brackets. Lead with the strongest one and keep your own commentary to a line or two.
3. Ask which numbers to apply. Never apply anything without an explicit choice.
4. Run `npx -y improvemyagent --apply <numbers>` (for example `--apply 1,3`, or `--apply all`). It applies from the last report, so the numbers match.
5. Show which files changed. Repo files are left uncommitted, and backups are in `~/.improvemyagent/backups`; offer to show the diff.

If the user wants a more thorough pass that also flags stale or conflicting lines in their existing files, add `--deep` to step 1 (about a minute).
