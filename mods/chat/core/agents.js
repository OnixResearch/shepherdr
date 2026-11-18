// What an agent runs on (agent, model, effort, speed, context) and how to start it again with other choices: the
// rules both the window's model menu (lib/agent.js, mods/chat-models) and the web app's use. Reading an agent's own
// settings and restarting it run where each side runs commands (lib/agent.js, service/agents.ts).
// Shared core: the source is core/agents.js; bin/sync-shared copies it into the mods in lib/COPIES.
// onix: omp is an agent kind everywhere a kind is named
export const NAMES = { claude: "Claude Code", codex: "Codex", omp: "omp" };

// Claude Code's current models, as its /model menu offers them. `id` is what --model gets;
// `match` the names a running agent may report for it.
const CLAUDE_MODELS = [
  { id: "opus", name: "Opus 5.5", match: ["opus", "claude-opus-5-5"] },
  { id: "opus[1m]", name: "Opus 5.5 · 1M", match: ["opus[1m]", "claude-opus-5-5[1m]"] },
  { id: "claude-fable-5-2", name: "Fable 5.2", match: ["fable", "claude-fable-5-2"] },
  { id: "sonnet", name: "Sonnet 5.5", match: ["sonnet", "claude-sonnet-5-5"] },
  { id: "haiku", name: "Haiku 5.5", match: ["haiku", "claude-haiku-5-5"] },
];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// onix: omp's permission modes, its --approval-mode, and its thinking levels (--thinking)
// omp's thinking levels (omp --thinking: off, minimal, low, medium, high, xhigh, max, auto), lowest first.
const OMP_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
// Permission modes as each CLI has them (Claude: --permission-mode, or
// --dangerously-skip-permissions for full access; Codex: its sandbox and approvals; omp: --approval-mode).
const PERMS = {
  claude: [{ id: "manual", label: "Ask" }, { id: "auto", label: "Auto" }, { id: "acceptEdits", label: "Accept edits" },
    { id: "plan", label: "Plan" }, { id: "bypassPermissions", label: "Full access" }],
  codex: [{ id: "read-only", label: "Read only" }, { id: "auto", label: "Auto" }, { id: "full", label: "Full access" }],
  // omp asks by itself above this: "manual" is its always-ask-cached, "auto" approves writes, "bypassPermissions" is yolo.
  omp: [{ id: "manual", label: "Ask" }, { id: "auto", label: "Write" }, { id: "bypassPermissions", label: "Full access" }],
};
// omp's --approval-mode for each of Shepherdr's: always-ask-cached asks, remembering an approval for the same call;
// write approves file writes and edits by itself and asks for the rest; yolo approves every tool call. (omp --help)
const OMP_APPROVAL = { manual: "always-ask-cached", auto: "write", bypassPermissions: "yolo" };
// and back: what a running omp's --approval-mode says in Shepherdr's words (always-ask asks every time: the same "Ask")
const OMP_PERM = { "always-ask": "manual", "always-ask-cached": "manual", write: "auto", yolo: "bypassPermissions" };
// A permission mode carried to the other agent when the agent is switched: its nearest mode there (auto stays auto,
// full access stays full access, Claude's accept edits is Codex's auto, plan and read only swap), else that agent's
// default (Claude's ask has no Codex match). Never silently drops auto to ask on a round trip (#758).
const PERM_ACROSS = {
  claude: { "read-only": "plan", auto: "auto", full: "bypassPermissions" },
  codex: { plan: "read-only", auto: "auto", acceptEdits: "auto", bypassPermissions: "full" },
  // omp has no read-only mode: a read-only pick is its Ask (omp's reviewer runs on Ask; the brief says read-only)
  omp: { manual: "manual", acceptEdits: "auto", plan: "manual", "read-only": "manual", full: "bypassPermissions", bypassPermissions: "bypassPermissions" },
};
export function permAcross(perm, agent, permDefault) {
  return PERM_ACROSS[agent]?.[perm] ?? (PERMS[agent]?.some((p) => p.id === perm) ? perm : null) ?? permDefault?.[agent] ?? null;
}

// What a model id says, in words: "claude-opus-5-5" → "Opus 5.5", "opus[1m]" → "Opus 1M".
export function modelName(id) {
  if (!id) return null;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}`;
  const a = /^([a-z]+)(\[1m\])?$/.exec(id);
  if (a) return `${a[1][0].toUpperCase()}${a[1].slice(1)}${a[2] ? " 1M" : ""}`;
  return id;
}

// A flag's value in argv: --model x, --model=x, or -m x.
function flag(argv, ...names) {
  for (let i = argv.length - 1; i >= 0; i--) {
    for (const n of names) {
      if (argv[i] === n && i + 1 < argv.length) return argv[i + 1];
      if (argv[i].startsWith(n + "=")) return argv[i].slice(n.length + 1);
    }
  }
  return null;
}
// Codex's -c key=value overrides.
function overrides(argv) {
  const out = {};
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "-c" && argv[i] !== "--config") continue;
    const m = /^([\w.]+)=(.*)$/.exec(argv[i + 1]);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// The agent's own settings on its machine: Claude's settings.json, Codex's config.toml and
// model list, omp's (which it keeps for itself: its catalog is `omp models --json`, lib/agent.js).
// Read once per agent process.
export const DEFAULTS = `
if [ "$1" = claude ]; then
  f="$HOME/.claude/settings.json"
  command -v jq >/dev/null && [ -f "$f" ] && jq -r '"model\\t\\(.model // "")", "effort\\t\\(.effortLevel // "")", "fast\\t\\(if .fastMode == true then "on" else "" end)", "per\\t\\(.modelSettings // {} | with_entries(.value |= (.effortLevel // null)) | tojson)", "mode\\t\\(.permissions.defaultMode // "")"' "$f" 2>/dev/null
# onix: omp keeps its own settings; its models are its catalog (lib/agent.js ompModels)
elif [ "$1" = omp ]; then
  true
else
  f="$HOME/.codex/config.toml"
  for k in model model_reasoning_effort service_tier sandbox_mode approval_policy; do
    printf '%s\\t%s\\n' "$k" "$(sed -n "s/^$k[[:space:]]*=[[:space:]]*\\"\\{0,1\\}\\([^\\"]*\\)\\"\\{0,1\\}.*/\\1/p" "$f" 2>/dev/null | head -1)"
  done
  c="$HOME/.codex/models_cache.json"
  [ -f "$c" ] && { printf 'models\\t'; tr -d '\\n' < "$c"; echo; }
fi
true`;

function parsePer(text) {
  try { return JSON.parse(text || "{}") ?? {}; } catch { return {}; }
}

// The agent's own settings, from DEFAULTS' output on its machine.
export function parseDefaults(kind, stdout) {
  const out = {};
  for (const line of (stdout ?? "").split("\n")) {
    const t = line.indexOf("\t");
    if (t > 0) out[line.slice(0, t)] = line.slice(t + 1);
  }
  let models = null;
  if (out.models) {
    try {
      models = (JSON.parse(out.models).models ?? []).filter((m) => m.visibility !== "hide").map((m) => ({
        id: m.slug, label: m.display_name || m.slug,
        efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter(Boolean),
        fast: (m.service_tiers ?? []).length > 0,
        ultrafast: (m.service_tiers ?? []).some((t) => t?.id === "ultrafast"),
        defaultEffort: m.default_reasoning_level ?? null,
      }));
    } catch {}
  }
  // onix: omp's own settings say no model or level (its catalog is read apart)
  if (kind === "omp") return { model: out.model || null, effort: out.effort || null };
  return kind === "claude"
    ? { model: out.model || null, effort: out.effort || null, fast: Boolean(out.fast), per: parsePer(out.per), mode: out.mode || null }
    : { model: out.model || null, effort: out.model_reasoning_effort || null, fast: speedOf(out.service_tier),
      sandbox: out.sandbox_mode || null, approval: out.approval_policy || null, models };
}

// What the agent runs on now: { agent, model, effort, fast, used, window, alias }.
export function current(kind, argv, meta, dflt) {
  argv = argv ?? [];
  meta = meta ?? {};
  dflt = dflt ?? {};
  if (kind === "claude") {
    // a /model in place (SHEP-181) names the row it switched to, its 1M too, which the log's turns don't say
    const alias = meta.alias ?? flag(argv, "--model") ?? dflt.model;
    let fast = dflt.fast;
    const s = flag(argv, "--settings");
    if (s && /"fastMode"\s*:\s*(true|false)/.test(s)) fast = /"fastMode"\s*:\s*true/.test(s);
    if (meta.speed) fast = speedOf(meta.speed) === true;
    const big = /\[1m\]/.test(alias ?? "") || (meta.used ?? 0) > 200000;
    // Claude keeps an effort per model (modelSettings), known once the log names the model.
    const per = meta.model ? dflt.per?.[meta.model] ?? dflt.per?.[meta.model.replace(/-\d+$/, "")] : null;
    const perm = argv.includes("--dangerously-skip-permissions") ? "bypassPermissions" : flag(argv, "--permission-mode") ?? dflt.mode ?? "manual";
    return { agent: "claude", model: meta.model ?? alias, alias, effort: meta.effort ?? flag(argv, "--effort") ?? per ?? dflt.effort,
      fast: Boolean(fast), perm: perm === "default" ? "manual" : perm, used: meta.used ?? null, window: meta.window ?? (big ? 1000000 : 200000) };
  }
  // onix: what a running omp runs on (its argv, its log, its catalog)
  if (kind === "omp") {
    // its log names the provider and the model apart: the picker's id is provider/model (omp's `selector`)
    const said = meta.model ? (String(meta.model).includes("/") || !meta.provider ? meta.model : `${meta.provider}/${meta.model}`) : null;
    const model = said ?? flag(argv, "--model") ?? dflt.model ?? null;
    const m = dflt.models?.find((x) => x.id === model) ?? null;
    const mode = flag(argv, "--approval-mode");
    const perm = OMP_PERM[mode] ?? dflt.perm ?? (argv.includes("--auto-approve") ? "bypassPermissions" : "manual");
    return { agent: "omp", model, label: m?.label ?? null, perm, effort: meta.effort ?? flag(argv, "--thinking") ?? dflt.effort ?? null,
      fast: false, used: meta.used ?? null, window: meta.window ?? m?.contextWindow ?? null };
  }
  const o = overrides(argv);
  const tier = o.service_tier;
  const model = meta.model ?? flag(argv, "-m", "--model") ?? o.model ?? dflt.model;
  const sandbox = flag(argv, "-s", "--sandbox") ?? o.sandbox_mode ?? dflt.sandbox;
  const perm = argv.includes("--dangerously-bypass-approvals-and-sandbox") || sandbox === "danger-full-access" ? "full"
    : sandbox === "read-only" ? "read-only" : "auto";
  return { agent: "codex", model, label: dflt.models?.find((m) => m.id === model)?.label ?? null, perm,
    effort: meta.effort ?? o.model_reasoning_effort ?? dflt.effort,
    fast: meta.speed ? speedOf(meta.speed) : tier ? speedOf(tier) : dflt.fast === "ultrafast" ? "ultrafast" : Boolean(dflt.fast), used: meta.used ?? null, window: meta.window ?? null };
}

// A chat's speed is its `fast`: false (standard), true (Fast) or "ultrafast" (Codex's Ultrafast tier, SHEP-258).
// From a word a CLI logs or a config says: Codex's service_tier (priority is what its config calls fast), Claude
// Code's usage.speed.
export function speedOf(word) {
  const w = String(word ?? "").trim().toLowerCase();
  return w === "ultrafast" ? "ultrafast" : w === "fast" || w === "priority";
}
// The service_tier Codex is started on: always said, so Fast off wins over one in config.toml (default: standard).
export const codexTier = (fast) => (fast === "ultrafast" ? "ultrafast" : fast ? "fast" : "default");
// The speed as a word the web app and the restart sheet pass: normal, fast or ultrafast.
export const speedWordOf = (fast) => (fast === "ultrafast" ? "ultrafast" : fast ? "fast" : "normal");
// The speed as the person reads it, null for standard.
export const speedName = (fast) => (fast === "ultrafast" ? "Ultrafast" : fast ? "Fast" : null);
// The speed a model can run on: an Ultrafast it lacks falls back to Fast, a Fast it lacks to standard.
export const speedFor = (m, fast) => (fast === "ultrafast" ? (m?.ultrafast ? "ultrafast" : m?.fast ? true : false) : Boolean(fast && m?.fast));

// An effort level as the person reads it: "xhigh" -> "Extra high". The CLIs still get the raw value.
const LEVELS = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra", none: "None" };
export function levelName(e) {
  return e ? LEVELS[e] ?? e[0].toUpperCase() + e.slice(1) : null;
}

// "Claude Code · Opus 5.5 · High · Fast"
export function line(c) {
  if (!c) return "";
  return [NAMES[c.agent], c.label ?? modelName(c.model), levelName(c.effort), speedName(c.fast)].filter(Boolean).join(" · ");
}

// How full the context window is: "38% context", or null.
export function contextWords(c) {
  if (!c?.used || !c.window) return null;
  return `${Math.min(100, Math.round((c.used / c.window) * 100))}% context`;
}

// What the model picker (mods/chat-models, the web's restart.tsx) shows for one agent, as plain data:
// { name, models: [{ id, name, efforts, defaultEffort, fast, ultrafast }], perms }: every model the CLI
// offers (Codex: its own models_cache.json; Claude Code: its /model menu), the picker searches them.
// `dflt` is that agent's settings (defaults()); `current` its running model, kept in the list.
export function menuFor(agent, dflt, current = null) {
  if (agent === "claude") {
    const models = CLAUDE_MODELS.map((m) => ({ id: m.id, name: m.name, efforts: CLAUDE_EFFORTS,
      defaultEffort: dflt?.per?.[m.match[1].replace(/\[1m\]$/, "")] ?? dflt?.effort ?? null, fast: m.id.startsWith("opus") }));
    // a model typed by id (an older one it still takes) stays in the list while it runs
    if (current && !models.some((m) => m.id === current)) models.unshift({ id: current, name: modelName(current), efforts: CLAUDE_EFFORTS, defaultEffort: dflt?.effort ?? null, fast: false });
    return { name: NAMES.claude, perms: PERMS.claude, models };
  }
  // onix: omp's menu is its catalog, its own levels and its approval modes
  // omp's models are its catalog's (parseOmpModels: `omp models --json` of the allowed providers) as Codex's are its own list
  const fallback = agent === "omp" ? OMP_EFFORTS : ["low", "medium", "high", "xhigh"];
  const all = (dflt?.models ?? []).map((m) => ({ id: m.id, name: m.label ?? m.name ?? m.id, efforts: m.efforts?.length ? m.efforts : fallback,
    defaultEffort: m.defaultEffort ?? dflt?.effort ?? null, fast: m.fast, ...(m.ultrafast ? { ultrafast: true } : {}) }));
  if (current && !all.some((m) => m.id === current)) all.unshift({ id: current, name: current, efforts: fallback, defaultEffort: dflt?.effort ?? null, fast: false });
  return { name: NAMES[agent] ?? agent, perms: PERMS[agent], models: all };
}

// The levels a model typed by id gets: its agent's usual ones.
export function typedModel(agent, id) {
  const efforts = agent === "claude" ? CLAUDE_EFFORTS : agent === "omp" ? OMP_EFFORTS : ["low", "medium", "high", "xhigh"];
  return { id, name: agent === "claude" ? modelName(id) : id, efforts, defaultEffort: null, fast: false, typed: true };
}

// onix: omp's model catalog and the onix.omp_providers allowlist
// ---- omp's model catalog ----------------------------------------------------------------------------------------
// `omp models --json` on the agent's machine: { models: [{ provider, id, kind, name, thinking, contextWindow, ... }] }
// (omp 18.22: a `selector` of provider/id is what --model takes). Only the providers Shepherdr's settings allow
// (onix.omp_providers, Everywhere) and only chat models: an embedding or image row is no agent's model.
export const OMP_PROVIDERS = ["underclass", "mesh"];
/** The onix.omp_providers setting as the list of providers: an array or one comma-separated line, lowercased; nothing
 *  usable: the default (OMP_PROVIDERS). */
export function ompProviders(value) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out = [...new Set(raw.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z0-9][a-z0-9_-]*$/.test(x)))];
  return out.length ? out : [...OMP_PROVIDERS];
}
/** Whether an omp model id can be said on its command line: omp reads a trailing ":<level>" in --model as a thinking
 *  level, and resolves a ":free" suffix as part of the id (its own OpenRouter free tier). */
export const ompModelOK = (id) => !String(id ?? "").includes(":") || String(id).endsWith(":free");
/** `omp models --json` as the model menu's models: [{ id: provider/model, label, efforts, defaultEffort, fast,
 *  contextWindow }] of the allowed providers, in the catalog's order. Unreadable: none. */
export function parseOmpModels(json, providers = OMP_PROVIDERS) {
  const allow = new Set(ompProviders(providers));
  let all;
  try { all = JSON.parse(String(json ?? "")).models; } catch { return []; }
  if (!Array.isArray(all)) return [];
  return all.filter((m) => m && m.kind === "chat" && m.id && allow.has(String(m.provider ?? "").toLowerCase()))
    .map((m) => {
      const id = `${m.provider}/${m.id}`;
      const thinking = Array.isArray(m.thinking) ? m.thinking.filter((t) => OMP_EFFORTS.includes(t)) : [];
      return { id, label: m.name || id, efforts: thinking.length ? thinking : OMP_EFFORTS, defaultEffort: null, fast: false,
        contextWindow: Number(m.contextWindow) || null };
    });
}

// onix: Claude Code and Codex through the Underclass pool (the Everywhere setting onix.underclass)
// ---- the Underclass pool --------------------------------------------------------------------------------------
// An agent sent through Underclass asks the pool's proxy instead of its own sign-in: Claude Code gets the proxy's
// address and an apiKeyHelper in its --settings, Codex a model provider of its own (-c) on the proxy's Responses API.
// Each reads the proxy key when it needs it from `herdr-task underclass-key` on its own machine, so no key is in an
// argv. herdr-task's underclass.py builds the same flags for the agents it starts (workers, reviewers, backups).
export const UNDERCLASS_CLIS = ["claude", "codex"];
export const UNDERCLASS_URL = "http://127.0.0.1:8080";
const UC_KEY = ["herdr-task", "underclass-key"];
const ucBase = (url) => String(url || UNDERCLASS_URL).replace(/\/+$/, "");
/** A settings file's Underclass choice: { claude, codex }, each the pool's address when that CLI goes through it, else
 *  false. Everywhere's onix.underclass (a list of CLIs) and onix.underclass_url (an http(s) address, else the default). */
export function underclassOf(file) {
  const onix = file?.everywhere?.onix ?? {};
  const list = Array.isArray(onix.underclass) ? onix.underclass.map((x) => String(x).trim().toLowerCase()) : [];
  const raw = typeof onix.underclass_url === "string" ? onix.underclass_url.trim() : "";
  const url = ucBase(/^https?:\/\//.test(raw) ? raw : UNDERCLASS_URL);
  return Object.fromEntries(UNDERCLASS_CLIS.map((c) => [c, list.includes(c) ? url : false]));
}
/** pick ({agent, model, …}) with the settings file's Underclass choice for its CLI, for argvFor; any other CLI's as it is. */
export const withUnderclass = (pick, file) =>
  (pick && UNDERCLASS_CLIS.includes(pick.agent) ? { ...pick, underclass: underclassOf(file)[pick.agent] } : pick);
// Claude Code's --settings keys, and Codex's -c overrides, that send it through the pool at url.
const ucClaude = (url) => ({ apiKeyHelper: UC_KEY.join(" "), env: { ANTHROPIC_BASE_URL: ucBase(url) } });
const ucCodex = (url) => ["-c", `model_provider="underclass"`, "-c",
  `model_providers.underclass={name="Underclass",base_url=${JSON.stringify(`${ucBase(url)}/v1`)},wire_api="responses",auth={command="${UC_KEY[0]}",args=["${UC_KEY[1]}"]}}`];
/** The pool's address an agent's argv goes through, else null: a resume, a fork or a switch keeps it. */
export function underclassIn(kind, argv) {
  argv = argv ?? [];
  if (kind === "claude") {
    let s = null;
    try { s = JSON.parse(flag(argv, "--settings") ?? "null"); } catch {}
    return s?.apiKeyHelper === UC_KEY.join(" ") ? ucBase(s?.env?.ANTHROPIC_BASE_URL) : null;
  }
  if (kind !== "codex") return null;
  const o = overrides(argv);
  if (o.model_provider !== "underclass") return null;
  const m = /base_url="([^"]+)"/.exec(o["model_providers.underclass"] ?? "");
  return ucBase(m ? m[1].replace(/\/v1\/?$/, "") : UNDERCLASS_URL);
}

// The person's picks in the model menus (the window's and the web's alike), in PICKS_FILE under the
// home of the machine the menu runs on: { pinned: ["codex:gpt-6-sol"], recent: [...] }, recent newest first.
export const PICKS_FILE = ".herdr/model-picks.json";
const RECENT = 5;
export const pickKey = (agent, id) => `${agent}:${id}`;
export function parsePicks(text) {
  let d = {};
  try { d = JSON.parse(text || "{}") ?? {}; } catch {}
  const list = (x) => (Array.isArray(x) ? x.filter((k) => typeof k === "string" && k.includes(":")) : []);
  return { pinned: list(d.pinned), recent: list(d.recent).slice(0, RECENT) };
}
// Restarted on it: first among the recent ones.
export function withRecent(picks, key) {
  return { ...picks, recent: [key, ...picks.recent.filter((k) => k !== key)].slice(0, RECENT) };
}
// The star: pinned to the top of its agent's list, or not any more.
export function withPin(picks, key) {
  return { ...picks, pinned: picks.pinned.includes(key) ? picks.pinned.filter((k) => k !== key) : [...picks.pinned, key] };
}

// Every word typed is in the model's name or id somewhere, any case ("op 1m" finds Opus 5.5 · 1M).
export function modelMatches(m, q) {
  const hay = `${m.name ?? ""} ${m.id}`.toLowerCase().replace(/[^a-z0-9.\[\] ]+/g, " ");
  return String(q ?? "").toLowerCase().split(/[^a-z0-9.\[\]]+/).filter(Boolean).every((w) => hay.includes(w));
}

// The model list as the picker shows it: sections of rows, at most CAP rows each (`more` counts the rest).
// Nothing typed: the agent shown (`agent`), its pinned models, then its recent ones, then all the rest in the
// CLI's order. Typed: every agent's matches, an agent to a section (its pinned and recent first), and, for one
// word no model of an agent has as its id, a row per such agent to start it on that id (`typed`).
// Each row: { agent, ...model, pinned }; a section: { key, title, agent, rows, more }.
export const CAP = 200;
export function modelSections(menus, agent, picks, q) {
  picks = picks ?? { pinned: [], recent: [] };
  const query = String(q ?? "").trim();
  const order = (k, models) => {
    const rank = (m) => {
      const key = pickKey(k, m.id), p = picks.pinned.indexOf(key), r = picks.recent.indexOf(key);
      return p >= 0 ? p : r >= 0 ? 1000 + r : 2000;
    };
    return models.map((m, i) => ({ m, i, r: rank(m) })).sort((a, b) => a.r - b.r || a.i - b.i)
      .map(({ m }) => ({ agent: k, ...m, pinned: picks.pinned.includes(pickKey(k, m.id)) }));
  };
  // a pinned or recent model typed by id (no CLI lists it) stays on offer
  const saved = (k) => {
    const models = menus?.[k]?.models ?? [], known = new Set(models.map((m) => m.id));
    const ids = [...new Set([...picks.pinned, ...picks.recent].filter((x) => x.startsWith(`${k}:`)).map((x) => x.slice(k.length + 1)))];
    return [...models, ...ids.filter((id) => !known.has(id)).map((id) => ({ ...typedModel(k, id), typed: false }))];
  };
  const capped = (key, title, k, rows) => ({ key, title, agent: k, rows: rows.slice(0, CAP), more: Math.max(0, rows.length - CAP) });
  if (!query) {
    const rows = order(agent, saved(agent));
    const pinned = rows.filter((r) => r.pinned);
    const recent = rows.filter((r) => !r.pinned && picks.recent.includes(pickKey(agent, r.id)));
    const rest = rows.filter((r) => !r.pinned && !picks.recent.includes(pickKey(agent, r.id)));
    return [
      ...(pinned.length ? [capped("pinned", "Pinned", agent, pinned)] : []),
      ...(recent.length ? [capped("recent", "Recent", agent, recent)] : []),
      ...(rest.length ? [capped("all", pinned.length || recent.length ? "All models" : "Models", agent, rest)] : []),
    ];
  }
  const out = [];
  // the agent shown first, then the others in their usual order
  for (const k of [agent, ...Object.keys(menus ?? {}).filter((x) => x !== agent)]) {
    const m = menus?.[k];
    if (!m) continue;
    const rows = order(k, saved(k).filter((x) => modelMatches(x, query)));
    if (rows.length) out.push(capped(k, m.name, k, rows));
  }
  // one word that could be an id, and no model has it: start any agent on it as typed
  if (/^[\w.\[\]-]{2,60}$/.test(query)) {
    const rows = [agent, ...Object.keys(menus ?? {}).filter((x) => x !== agent)]
      .filter((k) => menus?.[k] && !saved(k).some((m) => m.id === query)).map((k) => ({ agent: k, ...typedModel(k, query), pinned: false }));
    if (rows.length) out.push({ key: "typed", title: "Use the id typed", agent, rows, more: 0 });
  }
  return out;
}

// The picker row that is what runs now (`c` from current()), or the model as it is.
export function rowFor(agent, c) {
  if (agent !== "claude") return c?.model ?? null;
  const has = (m, x) => (m.match ?? [m.id]).includes(x);
  // What runs (the log's model) wins; the alias it was started with only tells which row of
  // that model (Opus or Opus 1M), since the log names both alike.
  const byAlias = c?.alias ? CLAUDE_MODELS.find((m) => has(m, c.alias)) : null;
  const byModel = c?.model ? CLAUDE_MODELS.find((m) => has(m, c.model)) : null;
  const same = byAlias && (!c?.model || (byAlias.match ?? [byAlias.id]).some((x) => x.replace(/\[1m\]$/, "") === c.model));
  return (same ? byAlias : byModel ?? byAlias)?.id ?? c?.model ?? null;
}

// Flags that are about what to resume, which model, effort or speed: set again by a restart.
const CLAUDE_DROP = new Set(["--model", "--effort", "--settings", "--session-id", "--resume", "-r", "--permission-mode"]);
const CLAUDE_BARE = new Set(["--continue", "-c", "--fork-session", "--dangerously-skip-permissions"]);
// Flags whose next word is their value (so it isn't taken for a first message).
const CLAUDE_VALUE = new Set(["--add-dir", "--mcp-config", "--append-system-prompt", "--system-prompt",
  "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--agent", "--agents", "--plugin-dir",
  "--fallback-model", "--output-format", "--input-format", "--name", "--setting-sources", "--betas", "--debug-file"]);
const CODEX_VALUE = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval",
  "-C", "--cd", "--add-dir", "-i", "--image", "--enable", "--disable", "--local-provider", "--oss"]);
// onix: omp's flags, as a restart states them again and keeps the rest
// omp's flags: what a restart states again (its model, thinking, approvals, session) and what it must keep (its own
// provider, profile and folders); every other flag is kept as it is (omp --help).
const OMP_SET = new Set(["--model", "--thinking", "--approval-mode"]);
const OMP_BARE = new Set(["--auto-approve"]);
const OMP_SESSION = new Set(["--resume", "-r", "--restore", "--continue", "-c"]);
// Flags whose next word is their value (so it isn't taken for a first message, and a restart keeps both).
const OMP_VALUE = new Set(["--smol", "--slow", "--plan", "--prewalk-into", "--plan-yolo-into", "--provider", "--api-key",
  "--system-prompt", "--system-prompt-template", "--append-system-prompt", "--profile", "--alias", "--cwd", "--mode",
  "--config", "--add-dir", "--session-dir", "--models", "--tools", "--skills", "--hook", "-e", "--extension", "--export",
  "--max-time", "--warn-cost", "--max-cost", "--spinner-interval", "--max-fps", "--motion", "--service-tier"]);

// Where the agent's own word (claude, codex, omp) is in argv: a terminal's argv starts with what launched it (nice,
// sh -c, env, the person's `bash -ic`), whose words are no agent flags (#1001: its -ic was Codex's `-i c`, an image).
function agentAt(argv) {
  return argv.findIndex((a, i) => (i === 0 || !String(a).startsWith("-")) && /^(claude|codex|omp)$/.test(String(a).split("/").pop()));
}

// onix: omp is one of the agent words a terminal's argv starts
// The agent a terminal's argv runs (claude, codex or omp), from its own word, else null: the chat reader's kinds don't
// know every agent (core/chat-reader.js), its argv does.
export function kindOfArgv(argv) {
  const at = agentAt(argv ?? []);
  return at < 0 ? null : String(argv[at]).split("/").pop();
}

// The old agent's flags worth keeping (permissions, folders, ...), without what is chosen again
// or a first message.
function kept(kind, argv) {
  const out = [];
  const rest = argv.slice(Math.max(agentAt(argv), 0) + 1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (kind === "claude") {
      if (CLAUDE_BARE.has(a)) continue;
      if (CLAUDE_DROP.has(a)) { if (rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
      if ([...CLAUDE_DROP].some((f) => a.startsWith(f + "="))) continue;
      if (CLAUDE_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
      if (a.startsWith("-")) out.push(a);
    // onix: omp's own flags kept, its model/thinking/approvals said again
    } else if (kind === "omp") {
      if (OMP_BARE.has(a) || OMP_SESSION.has(a)) { if (OMP_SESSION.has(a) && rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
      if (OMP_SET.has(a)) { if (rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
      if ([...OMP_SET, ...OMP_BARE].some((f) => a.startsWith(f + "="))) continue;
      if (OMP_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
      if (a.startsWith("-")) out.push(a);
    } else {
      if (i === 0 && (a === "resume" || a === "fork")) { if (rest[1] && !rest[1].startsWith("-")) i++; continue; }
      if (a === "--no-daemon" || a === "--dangerously-bypass-approvals-and-sandbox" || a === "--full-auto") continue;
      if (["-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval"].includes(a)) { i++; continue; }
      // onix: the Underclass provider too (argvFor says it again, or not, as the pick says)
      if ((a === "-c" || a === "--config") && /^(model|model_reasoning_effort|service_tier|model_provider|model_providers\.underclass)=/.test(rest[i + 1] ?? "")) { i++; continue; }
      if (CODEX_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
      if (a.startsWith("-")) out.push(a);
    }
  }
  return out.filter((x) => x !== undefined);
}

// The same agent, model and flags as `argv`, without what resumed a conversation (and without a
// first message), or null when argv resumed none: for a fresh start once that session is gone.
export function freshArgv(kind, argv) {
  const s = stripSession(kind, argv);
  return s?.resumed ? s.out : null;
}

// argv without its session (a resume, fork, session id or first message): { out, resumed }, or null when no
// claude/codex/omp word is in it.
function stripSession(kind, argv) {
  argv = argv ?? [];
  const at = agentAt(argv);
  if (at < 0) return null;
  const rest = argv.slice(at + 1), out = [argv[at]];
  let resumed = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (kind === "claude") {
      if (a === "--resume" || a === "-r" || a === "--session-id") { resumed ||= a !== "--session-id"; if (rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
      if (/^--(resume|session-id)=/.test(a)) { resumed ||= a.startsWith("--resume"); continue; }
      if (a === "--continue" || a === "-c") { resumed = true; continue; }
      if (a === "--fork-session") continue;
      if (CLAUDE_VALUE.has(a) || ["--model", "--effort", "--settings", "--permission-mode"].includes(a)) { out.push(a, rest[++i]); continue; }
    // onix: omp's session (--resume <path>, --restore, -c) comes off for a fresh start
    } else if (kind === "omp") {
      // --resume <id|path> and --restore <path> (a crash's turn, continued) both continue a conversation; -c too
      if (OMP_SESSION.has(a)) { resumed = true; if (a !== "--continue" && a !== "-c" && rest[i + 1] && !rest[i + 1].startsWith("-")) i++; continue; }
      if (/^--(resume|restore)=/.test(a)) { resumed = true; continue; }
      if (OMP_BARE.has(a) || [...OMP_BARE].some((f) => a.startsWith(f + "="))) continue;
      // its model, thinking and approvals stay (a resume runs them again), as Claude Code's do
      if (OMP_SET.has(a)) { out.push(a, rest[++i]); continue; }
      if ([...OMP_SET].some((f) => a.startsWith(f + "="))) { out.push(a); continue; }
      if (OMP_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
    } else {
      if (i === 0 && (a === "resume" || a === "fork")) { resumed = true; continue; }
      if (a === "--last") continue;
      if (CODEX_VALUE.has(a)) { out.push(a, rest[++i]); continue; }
    }
    // A word that isn't a flag or a flag's value: the session's id or a first message.
    if (a.startsWith("-")) out.push(a);
  }
  return { out: out.filter((x) => x !== undefined), resumed };
}

// How to start the chosen agent: { argv, resume } (resume: argv already continues the session).
// `session`: the old conversation's id when it can be resumed (same agent only).
export function argvFor(pick, old) {
  const same = pick.agent === old.agent;
  const flags = same ? kept(pick.agent, old.argv ?? []) : [];
  // onix: through the Underclass pool as the pick says (pick.underclass: the pool's address, or false), else as the
  // same agent went before (a pick that doesn't say keeps it)
  const pool = pick.underclass !== undefined ? pick.underclass || null : same ? underclassIn(pick.agent, old.argv ?? []) : null;
  if (pick.agent === "claude") {
    const a = ["claude", ...flags];
    if (pick.model) a.push("--model", pick.model);
    if (pick.effort) a.push("--effort", pick.effort);
    a.push("--settings", JSON.stringify({ fastMode: Boolean(pick.fast), ...(pool ? ucClaude(pool) : {}) }));
    if (pick.perm === "bypassPermissions") a.push("--dangerously-skip-permissions");
    else if (pick.perm) a.push("--permission-mode", pick.perm === "manual" ? "default" : pick.perm);
    if (same && old.session) return { argv: [...a, "--resume", old.session], resume: true, base: a };
    return { argv: a, resume: false, base: a };
  }
  // onix: omp starts as `omp` itself: --model provider/id, --thinking, --approval-mode
  if (pick.agent === "omp") {
    // omp's own word is argv[0]: never wrapped in env or sh (agent_key is basename(argv[0]))
    const a = ["omp", ...flags];
    if (pick.model) {
      if (!ompModelOK(pick.model)) throw new Error(`omp reads a model id with ":" in it as a thinking level, so ${pick.model} can't be one: pick a provider/model id.`);
      a.push("--model", pick.model);
    }
    if (pick.effort && OMP_EFFORTS.includes(pick.effort)) a.push("--thinking", pick.effort);
    const approval = OMP_APPROVAL[pick.perm];
    if (approval) a.push("--approval-mode", approval);
    if (same && old.session) return { argv: [...a, "--resume", old.session], resume: true, base: a };
    return { argv: a, resume: false, base: a };
  }
  // Codex runs its commands outside hc without --no-daemon (as herdr-task and restart.sh add).
  const a = [...flags, "--no-daemon", ...(pool ? ucCodex(pool) : [])];
  if (pick.model) a.push("-m", pick.model);
  if (pick.effort) a.push("-c", `model_reasoning_effort="${pick.effort}"`);
  // always said, so Fast off wins over a service_tier in config.toml (default: the standard tier)
  a.push("-c", `service_tier="${codexTier(pick.fast)}"`);
  if (pick.perm === "full") a.push("--dangerously-bypass-approvals-and-sandbox");
  else if (pick.perm === "read-only") a.push("-s", "read-only", "-a", "on-request");
  else if (pick.perm) a.push("-s", "workspace-write", "-a", "on-request");
  if (same && old.session) return { argv: ["codex", "resume", ...a, old.session], resume: true, base: ["codex", ...a] };
  return { argv: ["codex", ...a], resume: false, base: ["codex", ...a] };
}

// The conversation's id, from its log's file name. omp resumes by its session file's path (--resume <path>), so its
// session is the path itself (ompSessionId names the id in it).
export function sessionOf(kind, path) {
  const p = String(path ?? "");
  // onix: omp resumes by its session file's path
  if (kind === "omp") return /\.jsonl$/.test(p) ? p : null;
  const m = kind === "claude" ? /([0-9a-f-]{36})\.jsonl$/.exec(p) : /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(p);
  return m ? m[1] : null;
}
// onix: the id in an omp session file's name
// An omp session file's id: the uuid after the last `_` in its name (<ISO-ts>_<uuid>.jsonl).
export function ompSessionId(path) {
  const m = /_([0-9a-f-]{36})\.jsonl$/.exec(String(path ?? ""));
  return m ? m[1] : null;
}

// The same conversation again, after its agent ended (an Assistant's /exit, GitHub #1039): its own flags, model, effort
// and speed, resuming `session`.
export function resumeArgv(kind, argv, session) {
  const out = stripSession(kind, argv)?.out ?? [kind];
  // onix: omp resumes with --resume <session file path>, as Claude Code does with its id
  if (kind === "claude" || kind === "omp") return [...out, "--resume", session];
  return [out[0], "resume", ...out.slice(1), session];
}

// A copy of the conversation in a new tab beside this one, through the CLI's own fork. null: that CLI has none (omp),
// and the fork starts a new conversation with a handoff instead.
export function forkArgv(kind, argv, session) {
  // onix: omp has no fork flag: the fork starts a new conversation with a handoff
  if (kind === "omp") return null;
  argv = argv ?? [];
  // The same model, effort and speed as the original.
  const same = kind === "claude"
    ? ["--model", "--effort", "--settings"].flatMap((f) => { const v = flag(argv, f); return v ? [f, v] : []; })
    : (() => {
      const m = flag(argv, "-m", "--model"), o = overrides(argv);
      // onix: a conversation through the Underclass pool forks through it too
      const pool = underclassIn(kind, argv);
      return [...(m ? ["-m", m] : []), "--no-daemon", ...(pool ? ucCodex(pool) : []),
        ...["model_reasoning_effort", "service_tier"].flatMap((k) => (o[k] ? ["-c", `${k}="${o[k]}"`] : []))];
    })();
  const flags = [...kept(kind, argv), ...same];
  return kind === "claude" ? ["claude", ...flags, "--resume", session, "--fork-session"] : ["codex", "fork", ...flags, session];
}

// #1050: a fork of a task's conversation while the task's agent runs works in the same folder, so two agents would
// edit one worktree. The task's live agent (a terminal record from `all`, reviewers and helpers aside) when `t` is a
// task's terminal, else null: the fork then asks first (FORK_LIVE).
// onix: omp runs agents too, so a task's live agent can be one
const AGENT_APPS = new Set(["claude-code", "claude", "codex", "omp"]);
export function liveTaskAgent(t, all) {
  const task = t?.labels?.["herdr.task"];
  if (!task) return null;
  return [...(all ?? [])].find((k) => k?.state === "live" && k.labels?.["herdr.task"] === task
    && !["reviewer", "helper"].includes(k.labels?.["herdr.role"])
    // an agent runs there (a record that doesn't say what runs counts: better to ask once too often)
    && (AGENT_APPS.has(k.status?.app) || AGENT_APPS.has(k.foreground?.name) || (!k.status?.app && !k.foreground))) ?? null;
}
// The ask, in the window's confirm and the web's alike: keep the live agent (Cancel) or fork anyway.
export const FORK_LIVE = {
  title: "This task's agent is still running",
  detail: "A fork starts a second agent in the task's folder, and both would edit the same files. Keep working with the live one, or fork anyway.",
  verb: "Fork anyway",
  cancel: "Keep the live one",
};
