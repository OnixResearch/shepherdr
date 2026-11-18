import { expect, test } from "bun:test";
import { planRows, meterWords, windowWords, whyWords, freshWords, healthReadWords, noHealthWords, noPlanWords, cliTitle, readOld,
  meterSub, healthErrorWords, span, readSummary, READS } from "./machines.js";

const NOW = Date.UTC(2026, 10, 4, 12, 0);
const health = { cpu: 12, load: 0.5, cores: 8, memory: 40, mem_used: 8 * 2 ** 30, mem_total: 32 * 2 ** 30, disk: 22, disks: [{ path: "/", pct: 22, free_gb: 300 }] };

test("a machine's meter says its health, then each plan's least left", () => {
  const s = { health, limits: { claude: { state: "ok", at: NOW, windows: [{ name: "5-hour", used: 30, resets_at: NOW + 3600e3 }, { name: "Weekly", used: 81 }] } } };
  expect(meterWords(s)).toBe("CPU 12% · Memory 40% · Disk 22% · Claude Code 19% left");
});

test("an agent with no usage source says so; one with a source is never listed twice", () => {
  const rows = planRows({ limits: {}, agents: [{ key: "pi", name: "Pi" }, { key: "claude", name: "Claude Code" }] });
  expect(rows).toEqual([{ cli: "pi", name: "Pi", none: true }]);
});

test("the details' words, as the window's popup says them", () => {
  expect(freshWords(NOW - 5000, false, NOW)).toBe("Updated just now");
  expect(freshWords(NOW - 5 * 60e3, false, NOW)).toBe("Updated 5m ago");
  expect(freshWords(NOW, true, NOW)).toBe("Updating…");
  expect(healthReadWords({ error: "x" }, NOW)).toBe("Couldn't read it now");
  expect(healthReadWords({ at: NOW - 120e3 }, NOW)).toBe("Read 2m ago");
  expect(noHealthWords({ error: "timed out" })).toBe("Couldn't read it: timed out");
  expect(noPlanWords({ limitsAt: 1 })).toBe("No agent CLIs here.");
  expect(noPlanWords({})).toBe("Reading plan usage…");
  expect(whyWords({ state: "signed-out" })).toBe("Not signed in on this machine.");
  expect(whyWords({ state: "no-plan" })).toBe("No plan limits: not signed in to a subscription.");
  expect(cliTitle({ name: "Codex", read: { plan: "pro" } })).toBe("Codex · Pro");
  expect(readOld({ at: NOW - 20 * 60e3 }, NOW)).toBe(true);
  expect(meterSub({ detail: "Load 9.0 on 8 cores", level: "over" })).toBe("Load 9.0 on 8 cores · Over its alert limit");
  expect(healthErrorWords("No answer")).toBe("Couldn't read its health: No answer");
  expect(span(3 * 3600e3 + 10 * 60e3)).toBe("3h 10m");
});

test("a plan window: its numbers and refill, or that it refilled since", () => {
  const w = windowWords({ name: "Weekly", used: 81.4, resets: "Nov 9" }, NOW);
  expect(w).toEqual({ name: "Weekly", pct: 19, level: "busy", words: "19% left · 81% used", refill: "Refills Nov 9" });
  expect(windowWords({ name: "5-hour", used: 10 }, NOW).refill).toBe("No refill time reported");
  expect(windowWords({ name: "5-hour", used: 10, resets_at: NOW - 1 }, NOW).dead).toMatch(/^5-hour: refilled .+, not read since\.$/);
});

// onix: the Underclass pool and mesh-llm are plan limits too, with counts instead of windows.
test("the pool and the mesh are plan reads with their own names", () => {
  expect(READS.underclass).toBe("Underclass pool");
  expect(READS.mesh).toBe("mesh-llm");
  const rows = planRows({ limits: { underclass: { state: "ok", windows: [], accounts: [{ backend: "codex", status: "healthy" }],
    banked_resets: 2 }, mesh: { state: "ok", windows: [], mesh: { models: 12, peers: 3 } } } });
  expect(rows.map((r) => r.name)).toEqual(["Underclass pool", "mesh-llm"]);
  // neither has plan windows, so neither has a least-left: the summary line speaks for them.
  expect(rows.map((r) => r.pct)).toEqual([null, null]);
  expect(meterWords({ health, limits: { mesh: { state: "ok", windows: [], mesh: { models: 12, peers: 3 } } } }))
    .toBe("CPU 12% · Memory 40% · Disk 22%");
});

test("a read without plan windows says its counts: the pool's accounts and banked resets, the mesh's models and peers", () => {
  const pool = (accounts, banked) => ({ state: "ok", windows: [], accounts, banked_resets: banked });
  expect(readSummary(pool([{ backend: "codex" }, { backend: "claude" }, { backend: "codex" }], 2))).toBe("3 accounts · 2 resets banked");
  expect(readSummary(pool([{ backend: "codex" }], 1))).toBe("1 account · 1 reset banked");
  expect(readSummary(pool([{ backend: "codex" }], 0))).toBe("1 account");
  expect(readSummary(pool([], 0))).toBe("No accounts.");
  expect(readSummary({ state: "ok", windows: [], plan: "serving", mesh: { models: 12, peers: 3 } })).toBe("12 models · 3 peers");
  expect(readSummary({ state: "ok", windows: [], mesh: { models: 1, peers: 0 } })).toBe("1 model · 0 peers");
  expect(readSummary({ state: "ok", windows: [], mesh: { serving: ["a", "b"] } })).toBe("2 models");
  // a read with windows, one that failed, and anything else keep their own words.
  expect(readSummary({ state: "ok", windows: [{ name: "Weekly", used: 10 }] })).toBe(null);
  expect(readSummary({ state: "unknown", why: "timed out" })).toBe(null);
  expect(readSummary({ state: "ok", windows: [] })).toBe(null);
  expect(readSummary(null)).toBe(null);
});
