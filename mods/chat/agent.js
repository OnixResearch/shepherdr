// What the agent runs on (agent, model, effort, speed, context), for the line under the
// message box, and restarting it with other choices. The log says what it really runs on
// (log.js `meta`); its arguments and settings fill in what the log doesn't say.
// Restarting reuses Herdr's own ways: `herdr-task switch` for a task's agent, else the
// coordinator's restart.sh. The same agent resumes its conversation; another gets a handoff.
// Either way the new agent starts parked behind this chat (core label herdr.chat).
// Shared: the source is lib/agent.js; bin/sync-shared copies it into each mod in lib/COPIES.
// Edit lib/agent.js, never a mod's copy, then run bin/sync-shared.

import { exec, hc, appHome } from "herdr";
// The rules (names, menus, argv) are core/agents.js, shared with the web app.
// onix: omp's catalog and providers (core/agents.js)
import { DEFAULTS, parseDefaults, parseOmpModels, ompProviders, withUnderclass } from "./core/agents.js";
import { SH } from "./core/paths.js";
import { chatLabel } from "./core/spaces.js";
export * from "./core/agents.js";

export async function defaults(kind, machine) {
  // onix: omp's defaults are its catalog
  // omp's own settings hold no model list: its catalog is what it offers (ompModels, below)
  if (kind === "omp") return { model: null, effort: null, models: await ompModels(machine) };
  const r = await exec("sh", ["-c", DEFAULTS, "defaults", kind], { on: machine }).catch(() => null);
  return parseDefaults(kind, r?.stdout ?? "");
}

// onix: `omp models --json`, cached 10 minutes, of the allowed providers
// omp's model catalog (`omp models --json`) on a machine, at most once every 10 minutes (it takes seconds to answer):
// only the providers Shepherdr's settings allow (onix.omp_providers, Everywhere, so one list for every machine) and
// only chat models. A provider whose discovery fails for one read keeps the last list rather than showing none.
const OMP_STALE = 600000;
const ompSeen = new Map();
export async function ompModels(machine = null) {
  const s = await exec("sh", ["-c", `${SH}cat "$SHEP_SETTINGS" 2>/dev/null`], { on: machine }).catch(() => null);
  let file = {};
  try { file = JSON.parse(s?.stdout || "{}") ?? {}; } catch {}
  const providers = ompProviders(file?.everywhere?.onix?.omp_providers);
  const key = `${machine ?? ""}|${providers.join(",")}`;
  const was = ompSeen.get(key);
  if (was && Date.now() - was.at < OMP_STALE) return was.models;
  const r = await exec("omp", ["models", "--json"], { on: machine }).catch(() => null);
  const read = r?.code === 0 ? parseOmpModels(r.stdout, providers) : [];
  const models = read.length ? read : was?.models ?? [];
  ompSeen.set(key, { at: Date.now(), models });
  return models;
}

// onix: Claude Code and Codex through the Underclass pool (core/agents.js withUnderclass)
// pick with Shepherdr's settings' Underclass choice for its CLI (Everywhere's onix.underclass), for argvFor: read
// each time, so a switch follows Settings. An unreadable file leaves the pick as it is (argvFor keeps the old way).
export async function underclassPick(pick) {
  const s = await exec("sh", ["-c", `${SH}cat "$SHEP_SETTINGS"`]).catch(() => null);
  let file = null;
  try { file = JSON.parse(s?.stdout || "null"); } catch {}
  return file ? withUnderclass(pick, file) : pick;
}

// Restarts the agent `t` (hc get's record) with `argv`, parked behind chat pane `pane`.
// Resolves with the new agent's address.
export async function restart(t, built, pane) {
  const task = t.labels?.["herdr.task"];
  if (task) {
    // herdr-task resumes its own session when the agent stays the same.
    const r = await exec("herdr-task", ["switch", task, "--folder", t.foreground?.cwd ?? t.cwd, "--argv", JSON.stringify(built.base), "--json"]);
    let out = {};
    try { out = JSON.parse(r.stdout || "{}"); } catch {}
    if (r.code !== 0 || !out.terminal) throw new Error((r.stderr || r.stdout).trim() || "herdr-task switch failed");
    const origin = t.labels?.["herdr.chat.origin"] || t.address;
    await hc(["label", out.terminal, `herdr.chat=${chatLabel(pane)}`, `herdr.chat.origin=${origin}`]);
    // It started in the tab: park it behind this chat, as the Chat switch does.
    await exec("herdr-app", ["do", "terminal.park", "--terminal", out.terminal]);
    return out.terminal;
  }
  const env = `HERDR_RESTART_CHAT="$1"${built.resume ? " HERDR_RESTART_RESUME=1" : ""}`;
  const r = await exec("sh", ["-c", `${env} bash "$2" "$3" "$4"`, "x", chatLabel(pane), `${appHome()}/mods/coordinator/restart.sh`, t.address, JSON.stringify(built.argv)]);
  const addr = r.stdout.trim().split("\n").pop();
  if (r.code !== 0 || !addr) throw new Error(r.stderr.trim() || "The agent didn't restart.");
  return addr;
}

