export type Tool = "claude-code" | "codex" | "opencode" | "gemini" | "cursor";

export interface ToolCall {
  name: string;
  /** Short human-readable form of the input, e.g. the bash command or file path. */
  summary: string;
  isError: boolean;
  rejected: boolean;
}

export interface Turn {
  role: "user" | "assistant";
  /** User text with injected system blocks stripped; assistant prose. */
  text: string;
  toolCalls: ToolCall[];
  /** The user interrupted this assistant turn. */
  interrupted: boolean;
  ts: string;
}

export interface Session {
  tool: Tool;
  id: string;
  file: string;
  cwd: string;
  branch?: string;
  commit?: string;
  model?: string;
  startedAt: string;
  turns: Turn[];
}

/** A user message that may be a correction, with the agent action it reacted to. */
export interface Candidate {
  id: string;
  tool: Tool;
  sessionId: string;
  cwd: string;
  repo: string;
  ts: string;
  userText: string;
  /** What the agent did right before the user spoke. */
  agentAction: string;
  /** What the agent did right after the correction (usually the behavior the user wanted). */
  agentFix: string;
  /** The user's request that the agent was working on. */
  priorRequest: string;
  hardSignals: string[];
  /** Bash-like commands the agent ran just before, used to verify guards. */
  recentCommands: string[];
}

export type Label =
  | "correction"
  | "durable_preference"
  | "one_off_instruction"
  | "clarification"
  | "praise"
  | "neutral";

export interface Classified extends Candidate {
  label: Label;
  lesson: string;
  durable: boolean;
}

export type RuleStatus = "NEW" | "IGNORED" | "STALE" | "CONFLICT";
export type Enforcement = "text" | "guard";

export interface Guard {
  tool: "Bash";
  /** JS regex matched against the bash command. */
  pattern: string;
  message: string;
}

export interface Rule {
  id: string;
  title: string;
  text: string;
  kind: "convention" | "command" | "workflow" | "communication" | "safety";
  scope: "global" | "repo";
  repo?: string;
  status: RuleStatus;
  enforcement: Enforcement;
  guard?: Guard;
  /** For IGNORED/STALE/CONFLICT: the existing line it refers to. */
  existing?: { file: string; line: string };
  /** Files the rule text is written to (usually one AGENTS.md). */
  destinations: string[];
  /** One-line imports added to other tools' files so they read the same rules. */
  bridges: { file: string; line: string }[];
  evidence: Classified[];
  rationale: string;
  score: number;
  verification: Verification[];
  /** Roughly how many of your replies show this rule (model's count in the fast path). */
  mentions?: number;
  /** How often this mistake happened before the rule existed, for later before/after tracking. */
  baseline?: Baseline;
}

export interface Baseline {
  /** Corrections matching the rule in the window. */
  corrections: number;
  /** Sessions in scope (all, or this repo's) in the window. */
  sessions: number;
  days: number;
}

export interface Verification {
  tier: "A" | "B";
  kind: string;
  passed: boolean;
  detail: string;
}

export interface InstructionFile {
  path: string;
  kind: string;
  scope: "global" | "repo";
  repo?: string;
  content: string;
}

export interface RepoFacts {
  root: string;
  exists: boolean;
  packageManager?: string;
  lockfiles: string[];
  scripts: Record<string, string>;
  languages: string[];
}
