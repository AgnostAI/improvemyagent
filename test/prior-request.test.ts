import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatesFrom } from "../src/detect.ts";

const t = (role: "user" | "assistant", text: string, i: number) => ({ role, text, toolCalls: [], interrupted: false, ts: new Date(1_790_000_000_000 + i * 1000).toISOString() });
const session = (turns: ReturnType<typeof t>[]) => ({ tool: "claude-code", id: "s1", file: "", cwd: "/nowhere", startedAt: new Date(1_790_000_000_000).toISOString(), turns }) as any;

test("an ack between the request and the correction keeps the real request", () => {
  const [c] = candidatesFrom([
    session([
      t("user", "add a date picker to the checkout form", 0),
      t("assistant", "Installing react-datepicker.", 1),
      t("user", "ok", 2),
      t("assistant", "Installed and wired it in.", 3),
      t("user", "no, use the existing DatePicker component", 4),
    ]),
  ]);
  assert.equal(c.priorRequest, "add a date picker to the checkout form");
});

test("a new substantive message becomes the earlier request", () => {
  const cands = candidatesFrom([
    session([
      t("user", "add a date picker to the checkout form", 0),
      t("assistant", "Installing react-datepicker.", 1),
      t("user", "now wire it into the payment step too", 2),
      t("assistant", "Done.", 3),
      t("user", "no, use the existing DatePicker component", 4),
    ]),
  ]);
  assert.equal(cands.at(-1)!.priorRequest, "now wire it into the payment step too");
});
