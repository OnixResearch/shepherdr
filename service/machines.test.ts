// onix: the web's Plan usage gets what the window's has: the Underclass pool's accounts and banked resets and
// mesh-llm's counts, so core.readSummary can say "3 accounts · 2 resets banked" / "12 models · 3 peers" there too.
import { expect, test } from "bun:test";
import { Machines } from "./machines.ts";

const AT = 1_700_000_000_000;
const health = { cpu: 12, load: 0.5, cores: 8, memory: 40, mem_used: 8, mem_total: 32, disk: 22, disks: [] };
type Sent = { limits?: Record<string, { state?: string; plan?: string; why?: string; windows: unknown[]; accounts?: unknown[]; banked_resets?: number; mesh?: unknown }> };

test("of() forwards the pool's accounts and banked resets, and the mesh's counts", () => {
  const accounts = [{ backend: "codex", status: "healthy", plan: "pro", resets: 2 }];
  const mesh = { version: "0.72.2", peers: 3, serving: ["Qwen3.8-27B"], models: 12 };
  // `of()` reads only the map (the hub is for poll): a machine whose reads are already in it.
  const machines = new Machines({} as unknown as ConstructorParameters<typeof Machines>[0], () => []);
  machines.stats.set(null, { at: AT, limitsAt: AT, health, hold: {}, limits: {
    underclass: { state: "ok", at: AT, windows: [], accounts, banked_resets: 2 },
    mesh: { state: "ok", at: AT, plan: "serving", windows: [], mesh },
  } });
  const got = machines.of(null) as unknown as Sent; // `{}` only for a machine with no read; this one has one
  expect(got.limits?.underclass.accounts).toEqual(accounts);
  expect(got.limits?.underclass.banked_resets).toBe(2);
  // the pool has no plan of its own: the web's heading stays "Underclass pool"
  expect(got.limits?.underclass.plan).toBeUndefined();
  expect(got.limits?.mesh.plan).toBe("serving");
  expect(got.limits?.mesh.mesh).toEqual(mesh);
  expect(got.limits?.mesh.windows).toEqual([]);
});

test("other reads gain none of it", () => {
  const machines = new Machines({} as unknown as ConstructorParameters<typeof Machines>[0], () => []);
  machines.stats.set(null, { at: AT, limitsAt: AT, health, hold: {}, limits: {
    claude: { state: "ok", at: AT, windows: [{ name: "Weekly", used: 10 }] },
    codex: { state: "unknown", why: "timed out", at: AT },
  } });
  const got = machines.of(null) as unknown as Sent; // `{}` only for a machine with no read; this one has one
  const claude = got.limits?.claude;
  expect(claude?.windows).toEqual([{ name: "Weekly", used: 10 }]);
  expect(claude && "accounts" in claude).toBe(false);
  expect(claude && "banked_resets" in claude).toBe(false);
  expect(claude && "mesh" in claude).toBe(false);
  expect(got.limits?.codex).toEqual({ state: "unknown", why: "timed out", at: AT });
});
