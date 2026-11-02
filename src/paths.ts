import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = process.env.IMA_STATE_DIR ?? join(homedir(), ".improvemyagent");
mkdirSync(STATE_DIR, { recursive: true });
