import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIND, LOG } from "./chat-log.js";
import { ChatReader, KINDS, kindOf } from "./chat-reader.js";

// The scripts as they run on the agent's machine; finding is stood in for (no omp process in a test).
const run = async (script, args, env = {}) => {
  const p = Bun.spawn(["sh", "-c", script, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env, ...env } });
  return await new Response(p.stdout).text();
};

test("an omp terminal is a chat agent", () => {
  expect(KINDS.omp).toBe("omp");
  expect(kindOf({ status: { app: "omp" } })).toBe("omp");
  expect(kindOf({ foreground: { name: "omp" } })).toBe("omp");
  expect(kindOf({ status: { app: "bash" }, foreground: { name: "zsh" } })).toBe(null);
});

// omp's own sessions: title/session, then one entry per message (its synthetic words, never a real one's).
const ompAt = (s) => `2026-11-18T10:01:${String(s).padStart(2, "0")}.000Z`;
const line = (id, parentId, timestamp, message) => JSON.stringify({ type: "message", id, parentId, timestamp, runtime: { version: "18.22.0" }, message });
const session = [
  JSON.stringify({ type: "title", v: 1, title: "Test" }),
  JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: ompAt(0), cwd: "/tmp/x" }),
];

test("the reader follows an omp session as its log grows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-reader-"));
  const file = join(dir, "2026-11-18T10-01-00-000Z_aaaa.jsonl");
  const first = [
    line("u1", "s0", ompAt(1), { role: "user", attribution: "user", content: [{ type: "text", text: "Hello there" }] }),
    line("a1", "u1", ompAt(2), { role: "assistant", provider: "underclass", model: "deepseek-v4.1-flash", stopReason: "toolUse",
      usage: { totalTokens: 117 }, content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "src/a.js" } }] }),
  ];
  writeFileSync(file, [...session, ...first].join("\n") + "\n");
  const r = new ChatReader({ sh: async (script, args) => ({ code: 0, stdout: script === FIND ? file : await run(script, args) }) }, "t1");
  const t = { status: { app: "omp" }, foreground: { pid: 4242 } };
  expect(await r.locate(t)).toBe(true);
  expect([r.state, r.kind, r.path]).toEqual(["finding", "omp", file]);
  expect(await r.pull()).toBe(true);
  expect(r.state).toBe("ready");
  expect(r.conv.items.map((x) => x.kind)).toEqual(["user", "tools"]);
  // what the log gained since: its call answered, then its words
  writeFileSync(file, [...session, ...first,
    line("r1", "a1", ompAt(3), { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "one\ntwo" }], isError: false }),
    line("a2", "r1", ompAt(4), { role: "assistant", provider: "underclass", model: "deepseek-v4.1-flash", stopReason: "stop",
      usage: { totalTokens: 130 }, content: [{ type: "text", text: "Done." }] }),
  ].join("\n") + "\n");
  expect(await r.pull()).toBe(true);
  expect(r.conv.items.map((x) => x.kind)).toEqual(["user", "tools", "agent"]);
  const step = r.conv.items[1].steps[0];
  expect(typeof step.out).toBe("number");
  expect(r.conv.meta.used).toBe(130);
  rmSync(dir, { recursive: true });
});

test("FIND omp: the newest log in the folder of its working directory, written since it started", async () => {
  const home = mkdtempSync(join(tmpdir(), "omp-home-"));
  const cwd = join(home, "git", "proj");
  const dir = join(home, ".omp", "agent", "sessions", "-git-proj");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const agent = Bun.spawn(["sleep", "5"], { cwd });
  // One written before it started belongs to another agent: not its log
  const stale = join(dir, "2026-01-01T00-00-00-000Z_aaaa.jsonl");
  writeFileSync(stale, "\n");
  utimesSync(stale, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  expect((await run(FIND, ["chat", "omp", String(agent.pid)], { HOME: home })).trim()).toBe("pending");
  // the newest of the ones it wrote itself
  const older = join(dir, "2026-01-02T00-00-00-000Z_bbbb.jsonl");
  const newer = join(dir, "2026-01-03T00-00-00-000Z_cccc.jsonl");
  const now = new Date();
  writeFileSync(older, "\n");
  writeFileSync(newer, "\n");
  utimesSync(older, new Date(now.getTime() - 60000), new Date(now.getTime() - 60000));
  utimesSync(newer, now, now);
  expect((await run(FIND, ["chat", "omp", String(agent.pid)], { HOME: home })).trim()).toBe(newer);
  agent.kill();
  rmSync(home, { recursive: true });
});
