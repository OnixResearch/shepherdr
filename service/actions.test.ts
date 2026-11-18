import { expect, test } from "bun:test";
import { act } from "./actions.ts";
import type { Compat } from "./compat.ts";

// onix: the web's model menu and its star, for every agent kind Shepherdr runs (core/agents.js NAMES: Claude Code,
// Codex, omp). omp's model id is its provider's and its id's, and omp reads a ":" in one as a thinking level.

type Call = { pin?: [string, string]; change?: Record<string, unknown>; restart?: Record<string, unknown> };

function compat(calls: Call[]): Compat {
  const agents = {
    pin: (agent: string, model: string) => { calls.push({ pin: [agent, model] }); return { pinned: [], recent: [] }; },
    change: async (_a: string, _r: unknown, pick: Record<string, unknown>) => { calls.push({ change: pick }); return { live: true }; },
    restart: async (_a: string, _r: unknown, pick: Record<string, unknown>) => { calls.push({ restart: pick }); return "t9"; },
    info: async () => ({}),
    menu: async () => ({}),
    choices: async () => [],
    ownDefaults: async () => ({}),
  };
  return { agents, addrOf: (key: string) => (key === "t:1" ? "t1" : null), reader: () => null } as unknown as Compat;
}

const hub = null as never;

test("the model menu takes an omp pick: its kind, its provider/id model and its level", async () => {
  const calls: Call[] = [];
  await act(hub, { type: "restart", chat: "t:1", live: true, kind: "omp", model: "mesh/gpt-5.4", effort: "high", speed: "normal", perm: "auto" }, compat(calls));
  expect(calls[0]).toEqual({ change: { kind: "omp", model: "mesh/gpt-5.4", effort: "high", speed: "normal", perm: "auto" } });
  // its star is pinned in the same file Claude's and Codex's are
  await act(hub, { type: "model-pin", agent: "omp", model: "openrouter/llama:free" }, compat(calls));
  expect(calls[1]).toEqual({ pin: ["omp", "openrouter/llama:free"] });
});

test("a model id omp would read as a thinking level is never said to it, and another CLI isn't a kind", async () => {
  const calls: Call[] = [];
  await expect(act(hub, { type: "restart", chat: "t:1", live: true, kind: "pi", model: "x" }, compat(calls)))
    .rejects.toThrow("Pick Claude Code, Codex or omp");
  // openrouter/llama:high: dropped rather than passed (omp would take "high" for its thinking level)
  await act(hub, { type: "restart", chat: "t:1", live: true, kind: "omp", model: "openrouter/llama:high" }, compat(calls));
  expect(calls[0]?.change).toEqual({ kind: "omp", model: undefined, effort: undefined, speed: undefined, perm: undefined });
  // no provider: not omp's id either
  await act(hub, { type: "restart", chat: "t:1", live: true, kind: "omp", model: "gpt-5.4" }, compat(calls));
  expect(calls[1]?.change).toMatchObject({ kind: "omp", model: undefined });
  // a restart (not live) goes to the service's restart with the same pick
  await act(hub, { type: "restart", chat: "t:1", kind: "omp", model: "mesh/gpt-5.4", effort: "low", perm: "manual" }, compat(calls));
  expect(calls[2]).toEqual({ restart: { kind: "omp", model: "mesh/gpt-5.4", effort: "low", speed: undefined, perm: "manual" } });
});
