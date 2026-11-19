// onix: Kiln's CI as Shepherdr shows it (mods/kiln, the web app's Kiln link, the service's /api/kiln): where Kiln's
// website is, and the rules its pages read Kiln's records by, so the panel says what the website says. Kiln is an
// exact-revision CI service; its website is a page of its own (onix.kiln.url) that Kiln's tailnet proxy signs in by
// Tailscale identity. Nothing here talks to Kiln: the panel's mods/kiln/api.js does, with these rules. The words
// follow Kiln's website (its ui.js and web.js): a run's status, durations and times, the failure-first log, why a
// run ran, a project's streak and a worker's slots.
// Shared core: the source is core/kiln.js; bin/sync-shared copies it into the mods in lib/COPIES.

// ---- settings ------------------------------------------------------------------------------------

// onix.kiln as the panel reads it: Everywhere's, then this machine's (settings key machines by name, "local" for this
// computer, or the file's "here"); the most specific wins. url: Kiln's website (https://host:port, no path); ca: a PEM
// file on this computer for a certificate no public CA signed (Kiln's own). Unset or not http(s): url null.
export function kilnSettings(file) {
  const layer = (l) => (l && typeof l === "object" && l.onix && typeof l.onix === "object" && l.onix.kiln && typeof l.onix.kiln === "object" ? l.onix.kiln : {});
  const here = (file && typeof file.here === "string" && file.here) || "local";
  const merged = { ...layer(file?.everywhere), ...layer(file?.machines?.[here]) };
  const url = websiteOf(merged.url);
  const ca = typeof merged.ca === "string" && merged.ca.trim() ? merged.ca.trim() : null;
  return { url, origin: url, ca };
}

// A website address as Kiln checks it: scheme, host and port only (Kiln's proxy admits a mutation only from its own
// origin, and the panel's requests carry that origin). Anything else: null.
function websiteOf(value) {
  if (typeof value !== "string") return null;
  const m = /^(https?):\/\/([^/?#\s]+)\/?$/i.exec(value.trim());
  return m ? `${m[1].toLowerCase()}://${m[2]}` : null;
}

// ---- a run's status ------------------------------------------------------------------------------

export const NOT_RECORDED = "Not recorded";

const OUTCOMES = {
  Success: ["success", "Passed"],
  DomainFailure: ["failure", "Failed"],
  Denied: ["failure", "Denied"],
  ProviderError: ["failure", "Provider error"],
  TimedOut: ["failure", "Timed out"],
  Cancelled: ["cancelled", "Cancelled"],
  Unknown: ["unknown", "Unknown"],
};

// { status, label } for a recorded outcome and phase, as Kiln's pills: status is one of running, queued, success,
// failure, cancelled, unknown (the colour); a blocked untrusted run waits on an operator, so it is queued too.
export function outcomeStatus(outcome, phase) {
  const none = outcome === null || outcome === undefined || outcome === "";
  if (none && phase === "queued") return { status: "queued", label: "Queued" };
  if (none) return { status: "unknown", label: NOT_RECORDED };
  if (outcome === "Pending") {
    if (phase === "active") return { status: "running", label: "Running" };
    return { status: "queued", label: phase === "awaiting_approval" ? "Awaiting approval" : "Queued" };
  }
  if (typeof outcome === "string" && Object.hasOwn(OUTCOMES, outcome)) return { status: OUTCOMES[outcome][0], label: OUTCOMES[outcome][1] };
  return { status: "unknown", label: String(outcome) };
}

export const runStatus = (run) => outcomeStatus(run?.outcome, run?.phase);
export const isFailedRun = (run) => runStatus(run).status === "failure";
export const isRunningRun = (run) => runStatus(run).status === "running";
const isWaitingRun = (run) => runStatus(run).status === "queued";

// A workflow node's state as a pill: its own word for the label.
const NODE_STATUS = { Pending: "queued", Running: "running", Paused: "warning", Completed: "success", Failed: "failure",
  Cancelled: "cancelled", Skipped: "cancelled", Unknown: "unknown" };
export const nodeStatus = (state) => ({ status: NODE_STATUS[state] ?? "unknown", label: state ? String(state) : NOT_RECORDED });

// A failed run that was retried: what the retries came to, or null.
export function retryBadge(run) {
  const retries = Array.isArray(run?.retries) ? run.retries : [];
  if (!retries.length || !isFailedRun(run)) return null;
  if (retries.some((r) => r?.outcome === "Success")) return { status: "warning", label: "Failed, then passed on retry" };
  return { status: "failure", label: `Retried ${retries.length} time${retries.length === 1 ? "" : "s"}; not passed` };
}

// Done nodes of all: a running run's progress ("2 of 3 nodes complete").
export function nodeProgress(run) {
  const nodes = Array.isArray(run?.nodes) ? run.nodes : [];
  const done = nodes.filter((n) => ["Completed", "Failed", "Cancelled", "Skipped"].includes(n?.state)).length;
  return { done, total: nodes.length };
}

// What a run's warning line says: its diagnostic, an uncertain state, a stale view.
export function runWarnings(run, { stale = false } = {}) {
  const out = [];
  if (run?.error_code) out.push(`Service diagnostic: ${run.error_code}.`);
  if (run?.outcome === "Unknown" || /unknown|recover|unavailable/.test(String(run?.phase ?? "")))
    out.push("Execution state is uncertain or recovering. This is not a successful run; do not assume provider effects completed.");
  if (stale) out.push("Live observation is disconnected. These details may be stale.");
  return out;
}

// ---- times -----------------------------------------------------------------------------------------

const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const validMs = (ms) => typeof ms === "number" && Number.isFinite(ms);

// "4.2s", "42s", "3m 07s", "2h 05m"; unknown: Not recorded.
export function formatDuration(ms) {
  if (!validMs(ms) || ms < 0) return NOT_RECORDED;
  if (ms < 10 * SECOND) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ${String(Math.floor((ms % MINUTE) / SECOND)).padStart(2, "0")}s`;
  return `${Math.floor(ms / HOUR)}h ${String(Math.floor((ms % HOUR) / MINUTE)).padStart(2, "0")}m`;
}

const shortDate = (ms) => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
};

// "just now", "5m ago", "3h ago", "2d ago", "in 5m"; a date beyond 30 days; unknown: Not recorded.
export function formatRelative(ms, now = Date.now()) {
  if (!validMs(ms)) return NOT_RECORDED;
  const delta = now - ms, distance = Math.abs(delta);
  if (distance < 45 * SECOND) return "just now";
  if (distance > 30 * DAY) return shortDate(ms);
  const amount = distance < HOUR - MINUTE / 2 ? `${Math.max(1, Math.round(distance / MINUTE))}m`
    : distance < DAY - HOUR / 2 ? `${Math.round(distance / HOUR)}h` : `${Math.round(distance / DAY)}d`;
  return delta >= 0 ? `${amount} ago` : `in ${amount}`;
}

// A full local time: "Wed, Nov 18, 2026 17:42:09".
export function formatTime(ms) {
  if (!validMs(ms)) return NOT_RECORDED;
  const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]}, ${shortDate(ms)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const startOf = (run) => (validMs(run?.started_at_ms) ? run.started_at_ms : validMs(run?.created_at_ms) ? run.created_at_ms : null);
export const runStart = startOf;

// The run list's day headings, by local start day: Today, Yesterday, "Wed, Nov 18, 2026", Start not recorded. Keeps
// the runs' order; a day that comes back later in the order starts a new group.
export function dayGroups(runs, now = Date.now()) {
  const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const today = dayKey(now), yesterday = dayKey(now - DAY);
  const label = (ms) => {
    if (ms === null) return "Start not recorded";
    const k = dayKey(ms);
    if (k === today) return "Today";
    if (k === yesterday) return "Yesterday";
    return `${WEEKDAYS[new Date(ms).getDay()]}, ${shortDate(ms)}`;
  };
  const groups = [];
  for (const run of runs ?? []) {
    const l = label(startOf(run));
    const last = groups[groups.length - 1];
    if (last && last.label === l) last.runs.push(run);
    else groups.push({ label: l, runs: [run] });
  }
  return groups;
}

// ---- identities --------------------------------------------------------------------------------------

export const shortRevision = (rev) => (typeof rev === "string" && rev ? rev.slice(0, 12) : NOT_RECORDED);
export function shortIdentity(value) {
  const s = value === null || value === undefined || value === "" ? "Unavailable" : String(value);
  return s.length > 22 ? `${s.slice(0, 12)}…${s.slice(-6)}` : s;
}
// A run's own short name: "web-run-" and its first 8.
export const shortRun = (id) => (typeof id === "string" ? id.replace(/^web-run-([0-9a-f]{8})[0-9a-f]+$/, "web-run-$1") : "");

// A request id Kiln admits ([A-Za-z0-9._-]{1,128}); random, so a mutation is never mistaken for another.
export function requestId(random = Math.random) {
  let hex = "";
  for (let i = 0; i < 32; i++) hex += Math.floor(random() * 16).toString(16);
  return `shepherdr-${hex}`;
}

// A failed request as the website words it: "<code>: <message>".
export function errorText(status, body) {
  if (body && typeof body === "object" && typeof body.message === "string") return `${body.code ?? "error"}: ${body.message}`;
  return `Service request rejected (HTTP ${status}).`;
}

// ---- runs: the list and its filters ------------------------------------------------------------------

export const PAGE_SIZE = 25;

export const OUTCOME_FILTERS = [
  { value: "", label: "All outcomes" },
  { value: "failed", label: "All failures" },
  { value: "queued", label: "Queued" },
  { value: "pending", label: "Pending (queued or running)" },
  { value: "Success", label: "Passed (Success)" },
  { value: "DomainFailure", label: "Failed (DomainFailure)" },
  { value: "Denied", label: "Denied" },
  { value: "Cancelled", label: "Cancelled" },
  { value: "TimedOut", label: "Timed out (TimedOut)" },
  { value: "ProviderError", label: "Provider error (ProviderError)" },
  { value: "Unknown", label: "Unknown" },
];

// GET /api/runs's query for the browser's filters ({ q, project, outcome, source, order, cursor }).
export function runsQuery(f = {}, limit = PAGE_SIZE) {
  const parts = [["limit", String(limit)], ["order", f.order === "asc" ? "asc" : "desc"]];
  const add = (key, value) => { const v = typeof value === "string" ? value.trim() : ""; if (v) parts.push([key, v]); };
  add("q", f.q); add("project_id", f.project); add("outcome", f.outcome); add("source_revision", f.source); add("cursor", f.cursor);
  return "?" + parts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

// "8 shown of 57 matching retained runs · bounded page"
export function runsLine(page, { stale = false } = {}) {
  const n = page?.runs?.length ?? 0, total = page?.total;
  return `${n} shown of ${typeof total === "number" ? total : n} matching retained runs · bounded page${stale ? " · snapshot may be stale" : ""}`;
}

// ---- overview -----------------------------------------------------------------------------------------

// The health hero and its lists from GET /api/overview: failing projects first (newest failure first), what's in
// progress or unresolved, what passed.
export function overviewOf(ov) {
  const projects = Array.isArray(ov?.projects) ? ov.projects : [];
  const by = (h) => projects.filter((p) => p.health === h);
  const failing = by("failing").sort((a, b) => (b.latest_run?.completed_at_ms ?? 0) - (a.latest_run?.completed_at_ms ?? 0));
  const healthy = by("healthy");
  const active = by("active"), queued = by("queued");
  const passed = healthy.length, d = passed + failing.length + active.length + queued.length;
  const unresolved = projects.filter((p) => ["active", "queued", "unknown", "unavailable", "cancelled"].includes(p.health));
  const t = ov?.totals ?? {};
  return {
    total: projects.length,
    failing,
    passed: healthy,
    unresolved,
    busy: active.length + queued.length > 0,
    passRate: d ? Math.floor((passed * 100) / d) : null,
    denominator: d,
    excluded: { unknown: by("unknown").length, cancelled: by("cancelled").length, none: by("unavailable").length },
    chips: [
      { id: "failed", label: "Failed", count: t.failed ?? 0, status: "failure", go: { page: "runs", outcome: "failed" } },
      { id: "active", label: "Active", count: t.active ?? 0, status: "running", go: { page: "workers", worker_status: "busy" } },
      { id: "queued", label: "Queued", count: t.queued ?? 0, status: "queued", go: { page: "runs", outcome: "queued" } },
      { id: "unknown", label: "Unknown", count: t.unknown ?? 0, status: "unknown", go: { page: "runs", outcome: "Unknown" } },
      { id: "passed", label: "Passed", count: t.succeeded ?? 0, status: "success", go: { page: "runs", outcome: "Success" } },
      { id: "cancelled", label: "Cancelled", count: t.cancelled ?? 0, status: "cancelled", go: { page: "runs", outcome: "Cancelled" } },
      { id: "retained", label: "Retained", count: t.runs ?? 0, status: "neutral", go: { page: "runs" } },
    ],
  };
}

// ---- why a run ran -------------------------------------------------------------------------------------

const CHANGED_FALLBACKS = {
  no_base: "there was no earlier revision to compare with (a new reference or a manual run)",
  truncated: "too many files changed to list them exactly",
  unsupported_provider: "this source provider cannot list changed files",
  read_error: "the changed files could not be read",
};
const GRAPHS = { cargo: "Cargo", nix: "Nix" };
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const countText = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
function fallbackWords(reason) {
  if (typeof reason !== "string" || !reason) return "the inputs for an exact decision were not available";
  if (Object.hasOwn(CHANGED_FALLBACKS, reason)) return CHANGED_FALLBACKS[reason];
  const g = /^graph_unavailable(?::\s*(cargo|nix))?(?::\s*([\s\S]*))?$/.exec(reason);
  if (g) return `the ${g[1] ? `${GRAPHS[g[1]]} build graph` : "build graph"} could not be read${g[2] ? ` (${g[2].trim()})` : ""}`;
  return `the recorded fallback was “${reason}”`;
}

// One recorded reason: { text, sample }.
function reasonText(reason) {
  if (!reason || typeof reason !== "object" || typeof reason.kind !== "string") return { text: "A recorded reason could not be read.", sample: [] };
  const sample = strings(reason.sample).slice(0, 5);
  switch (reason.kind) {
    case "unscoped": return { text: "This project has no path scope, so every change runs it.", sample: [] };
    case "path": {
      const count = Number.isSafeInteger(reason.count) && reason.count >= sample.length ? reason.count : null;
      return { text: count === null ? "Changed files are in this project's scope." : `${countText(count, "changed file")} ${count === 1 ? "is" : "are"} in this project's scope.`, sample };
    }
    case "declared":
      return { text: reason.pattern ? `A changed file matches the declared dependency ${reason.pattern}.` : "A changed file matches a declared dependency.", sample };
    case "graph": {
      const graph = typeof reason.graph === "string" && reason.graph ? `${GRAPHS[reason.graph] ?? reason.graph} build graph` : "build graph";
      const from = typeof reason.from_package === "string" && reason.from_package ? reason.from_package : null;
      const via = typeof reason.via_package === "string" && reason.via_package ? reason.via_package : null;
      const text = !from || !via ? `A changed package reaches this project through the ${graph}.`
        : via === "*" ? `${from} changed; every project using the ${graph} depends on it.`
        : via === from ? `Package ${from} under this project's root changed (${graph}).`
        : `${graph[0].toUpperCase()}${graph.slice(1)}: ${via} depends on ${from}, which changed.`;
      return { text, sample: [] };
    }
    case "fallback": return { text: `Ran to be safe: ${fallbackWords(reason.reason)}.`, sample: [] };
    default: return { text: `Recorded reason “${reason.kind}” is not recognised by this console.`, sample: [] };
  }
}

// "Why this ran": the changed-files sentence and its reasons, or null when the run has no affected set.
export function whyRan(run) {
  const a = run?.affected;
  if (!a || typeof a !== "object") return null;
  const c = a.changed ?? {};
  const changed = Number.isSafeInteger(c.exact_count) ? `${countText(c.exact_count, "changed file")} against the previous revision.`
    : c.fallback ? `Changed files unknown: ${fallbackWords(c.fallback)}.` : null;
  return { changed, reasons: (Array.isArray(a.reasons) ? a.reasons : []).map(reasonText) };
}

// ---- logs ------------------------------------------------------------------------------------------------

export const LOG_READ_BYTES = 16384;
export const LOG_KEEP_CHARS = 256 * 1024;
const word = (pattern, flags = "i") => new RegExp(`(?<![\\w./\`-])(?:${pattern})(?![\\w/\`-]|\\.\\w)`, flags);
const STRONG = [
  /(?<![\w./-])error(?:\[[A-Za-z]?\d+\])?:/i,
  /^\s*(?:error|fatal)\b/i,
  /\bpanicked at\b/,
  word("FAILED", ""),
  /^\s*Traceback \(most recent call last\)/,
  /(?<![\w.])[A-Z]\w*(?:Error|Exception):/,
  /\bexit(?:ed with)?(?: exit)? (?:code|status)\D{0,3}[1-9]/i,
];
const WEAK = word("error|failed|fatal");
const BENIGN = /\b(?:0|no|zero|without) (?:errors?|failed|failures?|fatal)\b|\b(?:errors?|failed|failures?)[:=] ?0\b/i;
function isErrorLine(line) {
  const s = line.length > 2048 ? line.slice(0, 2048) : line;
  if (STRONG.some((p) => p.test(s))) return true;
  return WEAK.test(s) && !BENIGN.test(s);
}
// The indexes of a text's error lines (at most 1000), as the website marks them.
export function errorLines(text) {
  if (typeof text !== "string" || !text) return [];
  const lines = text.split("\n"), out = [];
  for (let i = 0; i < lines.length && out.length < 1000; i++) if (isErrorLine(lines[i])) out.push(i);
  return out;
}

// Where a failed run's logs open: its first failed node, on stderr. Others: the first node, stdout.
export function failureFirst(run) {
  const nodes = Array.isArray(run?.nodes) ? run.nodes : [];
  if (isFailedRun(run)) {
    const failed = nodes.find((n) => /failed|error/i.test(String(n?.state ?? "")));
    return { node: (failed ?? nodes[0])?.id ?? null, stream: "stderr" };
  }
  return { node: nodes[0]?.id ?? null, stream: "stdout" };
}

// ---- pipeline ----------------------------------------------------------------------------------------------

// A workflow's stages: each node at its longest dependency depth (Kahn's order), or the problem that stops a graph.
export function pipelineStages(nodes, edges) {
  if (!Array.isArray(nodes) || !nodes.length) return { stages: [], problem: "No admitted nodes are recorded for this run." };
  if (!Array.isArray(edges)) return { stages: [], problem: "Dependency graph unavailable for this historical run: its edges were not recorded." };
  const ids = nodes.map((n) => n?.id);
  if (ids.some((id) => typeof id !== "string" || !id)) return { stages: [], problem: "A node has no id." };
  if (new Set(ids).size !== ids.length) return { stages: [], problem: "Two nodes share an id." };
  const known = new Set(ids), seen = new Set(), into = new Map(ids.map((id) => [id, 0])), out = new Map(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!known.has(e?.source) || !known.has(e?.target)) return { stages: [], problem: `An edge names a node that isn't recorded (${e?.source} → ${e?.target}).` };
    const key = `${e.source}\u0000${e.target}`;
    if (seen.has(key)) return { stages: [], problem: `The edge ${e.source} → ${e.target} is recorded twice.` };
    seen.add(key);
    out.get(e.source).push(e.target);
    into.set(e.target, into.get(e.target) + 1);
  }
  const depth = new Map(ids.map((id) => [id, 0])), queue = ids.filter((id) => into.get(id) === 0);
  let done = 0;
  while (queue.length) {
    const id = queue.shift();
    done++;
    for (const t of out.get(id)) {
      depth.set(t, Math.max(depth.get(t), depth.get(id) + 1));
      into.set(t, into.get(t) - 1);
      if (into.get(t) === 0) queue.push(t);
    }
  }
  if (done !== ids.length) return { stages: [], problem: "The recorded dependencies form a cycle." };
  const stages = [];
  for (const n of nodes) (stages[depth.get(n.id)] ??= []).push(n);
  return { stages, problem: null };
}

// ---- a project's history -------------------------------------------------------------------------------------

const finishedAt = (r) => (validMs(r?.completed_at_ms) ? r.completed_at_ms : null);

// From a project's newest runs (newest first): the latest finished run, its streak ("Passing for 5 runs"), the
// last success and last failure, and how many are in progress. truncated: more runs exist than were read.
export function projectHistory(runs, { truncated = false } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const finished = list.filter((r) => r?.phase === "terminal" && r.outcome && r.outcome !== "Pending");
  const inProgress = list.filter((r) => isRunningRun(r) || isWaitingRun(r)).length;
  const latest = finished[0] ?? null;
  const lastSuccess = finished.find((r) => r.outcome === "Success") ?? null;
  const lastFailure = finished.find((r) => isFailedRun(r)) ?? null;
  if (!latest) return { latest: null, headline: "No finished runs yet", since: null, lastSuccess, lastFailure, inProgress };
  const s = runStatus(latest).status;
  let count = 0;
  while (count < finished.length && runStatus(finished[count]).status === s) count++;
  const words = { success: "Passing", failure: "Failing", cancelled: "Cancelled", unknown: "Outcome unknown" }[s] ?? "Outcome unknown";
  const atLeast = truncated && count === finished.length ? "at least " : "";
  const since = finishedAt(finished[count - 1]) ?? runStart(finished[count - 1]);
  return { latest, headline: `${words} for ${atLeast}${countText(count, "run")}`, since, lastSuccess, lastFailure, inProgress };
}

// Terminal runs with a recorded duration, oldest first by ordinal: the duration trend's bars.
export function durationPoints(runs) {
  const points = [];
  let excluded = 0;
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || typeof r.outcome !== "string" || !r.outcome || r.outcome === "Pending") continue;
    if (!Number.isSafeInteger(r.duration_ms) || r.duration_ms < 0) { excluded++; continue; }
    points.push({ id: r.id, ms: r.duration_ms, status: runStatus(r).status, ordinal: Number.isSafeInteger(r.ordinal) ? r.ordinal : Infinity });
  }
  points.sort((a, b) => a.ordinal - b.ordinal);
  return { points, excluded };
}

// Projects grouped by the repository they share (the CI projects page).
export function repositoryGroups(projects) {
  const groups = [];
  const byKey = new Map();
  for (const p of Array.isArray(projects) ? projects : []) {
    const key = p?.repository_key ?? null;
    let g = key !== null ? byKey.get(key) : undefined;
    if (!g) {
      g = { repository: p?.repository ?? null, projects: [] };
      groups.push(g);
      if (key !== null) byKey.set(key, g);
    }
    g.projects.push(p);
  }
  return groups.map((g) => ({ ...g, shared: g.projects.length > 1 }));
}

// ---- workers -------------------------------------------------------------------------------------------------------

export const WORKER_STATUS = {
  slots_available: { status: "neutral", label: "Slots available", meaning: "At least one enrolled project slot is free." },
  busy: { status: "running", label: "Busy", meaning: "Every enrolled project slot has a run." },
  unknown: { status: "warning", label: "Unknown execution", meaning: "A run on this target is in an unknown state." },
  not_enrolled: { status: "neutral", label: "Not enrolled", meaning: "No project on this target is enrolled." },
  offline: { status: "warning", label: "No current heartbeat", meaning: "The target's heartbeat is not current." },
};
export const workerStatus = (w) => WORKER_STATUS[w?.status] ?? { status: "unknown", label: String(w?.status ?? NOT_RECORDED), meaning: "" };

export function heartbeatLabel(w) {
  if (w?.liveness === "online") return { status: "success", label: "Recent heartbeat" };
  if (w?.liveness === "offline") return { status: "warning", label: "Not current" };
  if (w?.observed_capacity) return { status: "neutral", label: "Liveness unknown" };
  return { status: "neutral", label: "Not observed" };
}

// A target's name: up to two project labels, then "+N more".
export function workerLabel(w) {
  const names = (Array.isArray(w?.projects) ? w.projects : []).map((p) => p?.label || p?.id).filter(Boolean);
  if (!names.length) return shortIdentity(w?.id);
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2} more` : names.join(", ");
}

// ---- mutations ---------------------------------------------------------------------------------------------------

// The website's confirmation words for a run's controls.
export function confirmWords(action, label, run) {
  const keep = run?.phase === "queued" ? "Keep queued" : run?.phase === "awaiting_approval" ? "Keep awaiting approval" : "Keep running";
  switch (action) {
    case "cancel": return { title: `Cancel run “${label}”?`, verb: "Cancel run", cancel: keep, danger: true };
    case "approve": return { title: `Approve untrusted run “${label}”?`, verb: "Approve and run", cancel: "Keep blocked", danger: false };
    case "rerun-exact": return { title: `Rerun “${label}” at the exact revision?`, verb: "Rerun", cancel: "Cancel", danger: false };
    case "rerun-latest": return { title: `Run “${label}” on the latest admitted reference?`, verb: "Run latest", cancel: "Cancel", danger: false };
    case "rerun-failed": return { title: `Retry failed nodes of “${label}”?`, verb: "Retry failed nodes", cancel: "Cancel", danger: false };
    default: return { title: `${action} “${label}”?`, verb: "OK", cancel: "Cancel", danger: false };
  }
}

export const CONTROL_NOTE = "This affects the exact execution/source below. Mutations are never automatically retried. Unknown effects require observation before a new request.";

// A cancel's body: an active run names its exact attempt; a queued or blocked one only asks.
export function cancelBody(run) {
  if (run?.phase === "queued" || run?.phase === "awaiting_approval") return { action: "cancel" };
  return { action: "cancel", attempt_id: run?.attempt_id, expected_revision: run?.revision, expected_sequence: run?.sequence, execution: run?.execution };
}
export const canCancel = (run) => run?.controls?.cancel === true
  && (run.phase === "queued" || run.phase === "awaiting_approval" || (!!run.attempt_id && Number.isSafeInteger(run.revision) && !!run.execution && Number.isSafeInteger(run.sequence)));
export const canRetryFailed = (run) => (Array.isArray(run?.nodes) ? run.nodes : []).some((n) => /^(failed|error)$/i.test(String(n?.state ?? "")));
