// onix: Kiln's run inspector (the website's ?page=runs&run=…): the run header — its status, warnings, progress, facts,
// why it ran, an untrusted pull request's gate and the exact identities — then the run's tabs in the website's order:
// Pipeline, Logs, Artifacts, Tests & coverage, Reviews, Compare & flaky, Activity and Evidence. The header's controls
// are the website's own (cancel, approve, rerun), asked first with its words, sent once, never retried. A failed run
// opened on Pipeline or Logs shows both panels, as the website does at every width. Reads: GET only; the log follows
// by cursor every 2 s while Follow is on. Words and rules come from core/kiln.js; nothing here writes to Kiln except
// through k.send.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { theme } from "herdr";
import { button, link, segmented, toggleSwitch, TEXT, RADIUS, red } from "./ui.js";
import {
  runStatus, nodeStatus, retryBadge, nodeProgress, runWarnings, formatDuration, formatTime, formatRelative,
  shortRevision, shortIdentity, whyRan, errorLines, failureFirst, pipelineStages, confirmWords, cancelBody,
  canCancel, canRetryFailed, isFailedRun, isRunningRun, LOG_READ_BYTES, LOG_KEEP_CHARS, outcomeStatus, NOT_RECORDED,
} from "./core/kiln.js";
import { pill, tag, chips, facts, card, words, emptyState, errorState, warningLine, loadingLine, rowLink, meter, icon, tone, MONO } from "./look.js";
import { activityTitle, activityMeta } from "./overview.js";

const VIEWS = [
  ["pipeline", "Pipeline"], ["logs", "Logs"], ["artifacts", "Artifacts"], ["tests", "Tests & coverage"],
  ["reviews", "Reviews"], ["compare", "Compare & flaky"], ["activity", "Activity"], ["evidence", "Evidence"],
];
const STREAMS = [["stdout", "stdout"], ["stderr", "stderr"], ["diagnostic", "diagnostic"]];
const CONTROL_FRESH_MS = 30000;
const FOLLOW_MS = 2000;
const LOG_VIEW_HEIGHT = 420;
const PATH_NOTES = { fork: "The pull request comes from a fork.", author_without_push_access: "The author has no recorded push access to the repository." };
const GATE_STATES = {
  awaiting_approval: ["queued", "Awaiting approval"],
  approved: ["success", "Approved to run untrusted"],
  superseded: ["cancelled", "Superseded by a newer commit"],
};
const CASE_STATES = {
  passed: ["success", "Passed"], failed: ["failure", "Failed"], error: ["failure", "Error"], skipped: ["cancelled", "Skipped"],
};
// Patchgate's own change states (kiln.patchgate.review.v1): label, colour, meaning and the next step Patchgate names.
const REVIEW_DECISIONS = {
  accepted: ["success", "Accepted", "Patchgate accepted the change.", ""],
  rejected: ["failure", "Rejected", "Patchgate rejected the change. It stays in the inbox and is not applied to main.", "Remove or replace the change in the inbox, then record a corrected change."],
  escalated: ["warning", "Escalated", "A person must decide.", "Resolve the change in a separate workspace, or reject it."],
  blocked: ["warning", "Blocked", "A prerequisite was rejected, escalated, removed or blocked, or its state is unknown, so Patchgate will not apply this change.", "Decide the prerequisites first."],
  waiting: ["queued", "Waiting", "A prerequisite is not in main yet, so the change waits for it.", "Decide the prerequisites first."],
  pending: ["queued", "Pending", "Patchgate has not decided this change yet.", "Review the change."],
  removed: ["cancelled", "Removed", "Patchgate accepted the change before, but it is no longer in main.", "Examine the removal from main before deciding again."],
  reverted: ["cancelled", "Reverted", "The change was accepted, then removed from main with patchgate revert.", "Examine the removal from main before deciding again."],
  unknown: ["unknown", "Unknown", "Patchgate recorded a decision it does not recognize for this change.", "Examine the channel and the change's prerequisites."],
};
const REVIEW_ORDER = ["rejected", "escalated", "blocked", "unknown", "missing", "removed", "reverted", "waiting", "pending", "accepted"];
const CANONICAL_OUTCOMES = new Set(["Success", "DomainFailure", "Denied", "ProviderError", "TimedOut", "Cancelled", "Unknown", "Pending"]);

// ---- per-run UI state --------------------------------------------------------------------------------------------------

function freshUi() {
  return {
    freshAt: 0,          // when the detail was last loaded or adopted (the website's 30 s control window)
    ids: false,          // "Exact source & execution identities" open
    log: null,           // the displayed log: channel, text, cursors, cursor notes, error lines
    logToken: 0,         // drops a read whose channel changed while it was in flight
    follow: null,        // Follow as the person left it (null: on for a running run)
    cases: {},           // test cases and coverage files the person opened (defaults open for failed and error)
    jumps: false,        // the first error lines shown above the log
    activityCursor: "",
    fields: {},
  };
}
const uiOf = (k) => (k.runUi ??= freshUi());
const idOf = (k) => k.route?.run ?? "";
const enc = (value) => encodeURIComponent(String(value ?? ""));
const detailKey = (id) => `run:${id}`;
const artifactsKey = (id) => `run-artifacts:${id}`;
const reportsKey = (id) => `run-reports:${id}`;
const evidenceKey = (id) => `run-evidence:${id}`;
const compareKey = (id, other) => `run-compare:${id}:${other}`;
const choicesKey = (id) => `run-others:${id}`;
const activityKey = (id, cursor) => `run-activity:${id}:${cursor}`;
const logKeyOf = (id, node, stream, search) => `${id}\u0000${node}\u0000${stream}\u0000${search}`;

export function reset(k) {
  k.runUi = freshUi();
}

function runOf(k) {
  const id = idOf(k);
  return id ? k.data(detailKey(id)) : null;
}

export function title(k) {
  const run = runOf(k);
  return run?.project_id ? k.projectLabel(run.project_id) : "Run";
}

// A live snapshot RunView (no retries) for the open run: newer by revision, or by sequence at equal revision. Never
// older. A changed snapshot refreshes the website's 30 s control window; heartbeats do not.
export function adopt(k, runs) {
  const id = idOf(k);
  if (!id) return false;
  const snap = (Array.isArray(runs) ? runs : []).find((r) => r?.id === id);
  if (!snap) return false;
  const cache = k.cache[detailKey(id)];
  if (cache?.data && !newer(snap, cache.data)) return false;
  const data = { ...snap, retries: Array.isArray(cache?.data?.retries) ? cache.data.retries : [] };
  k.cache[detailKey(id)] = { data, error: cache?.error ?? null, at: cache?.at ?? 0, loading: false };
  uiOf(k).freshAt = Date.now();
  return true;
}
function newer(a, b) {
  const revA = Number.isSafeInteger(a?.revision) ? a.revision : -1;
  const revB = Number.isSafeInteger(b?.revision) ? b.revision : -1;
  if (revA !== revB) return revA > revB;
  const seqA = Number.isSafeInteger(a?.sequence) ? a.sequence : -1;
  const seqB = Number.isSafeInteger(b?.sequence) ? b.sequence : -1;
  return seqA > seqB;
}

function fresh(k) {
  const at = uiOf(k).freshAt;
  return k.live.connected && at > 0 && Date.now() - at < CONTROL_FRESH_MS;
}
function controlsDisabled(k) {
  return k.mutating || k.stale() || !fresh(k);
}

// ---- loading -----------------------------------------------------------------------------------------------------------

const wantsLog = (run, view) => view === "logs" || (view === "pipeline" && isFailedRun(run));

export async function load(k, cx, opts = {}) {
  const id = idOf(k);
  if (!id) return;
  const base = `/api/runs/${enc(id)}`;
  const detail = await k.fetch(detailKey(id), base);
  if (idOf(k) !== id) return;
  if (detail?.data && !detail.error) uiOf(k).freshAt = Date.now();
  await k.fetch(artifactsKey(id), `${base}/artifacts`);
  if (idOf(k) !== id) return;
  const run = detail?.data;
  if (!run) return;
  const view = k.route.view || "pipeline";
  const jobs = [];
  if (view === "tests" || view === "reviews") jobs.push(k.fetch(reportsKey(id), `${base}/reports`));
  if (view === "evidence") jobs.push(k.fetch(evidenceKey(id), `${base}/evidence`));
  if (view === "activity") jobs.push(k.fetch(activityKey(id, uiOf(k).activityCursor), activityPath(k, id)));
  if (view === "compare") {
    jobs.push(k.fetch(choicesKey(id), `/api/runs?limit=20&order=desc&project_id=${enc(run.project_id)}`));
    const other = k.route.other;
    if (other) jobs.push(k.fetch(compareKey(id, other), `${base}/compare?other=${enc(other)}`));
  }
  await Promise.all(jobs);
  if (idOf(k) !== id) return;
  if (!wantsLog(run, view)) return;
  const ch = channel(k, run);
  const key = ch.node ? logKeyOf(id, ch.node, ch.stream, ch.stream === "diagnostic" ? "" : ch.search) : "";
  const lg = uiOf(k).log;
  if (!lg || lg.run !== id || lg.key !== key || lg.error) await readLogNow(k, { mode: "start" });
}

function activityPath(k, id) {
  const cursor = uiOf(k).activityCursor;
  return `/api/runs/${enc(id)}/activity?limit=50${cursor ? `&cursor=${enc(cursor)}` : ""}`;
}
// The activity page's cursor is per-run panel state (the frame's route has no activity cursor field).

// ---- the log channel -----------------------------------------------------------------------------------------------------

function channel(k, run) {
  const nodes = Array.isArray(run?.nodes) ? run.nodes : [];
  const ids = new Set(nodes.map((n) => n?.id).filter(Boolean));
  const u = uiOf(k);
  const lg = u.log?.run === run?.id ? u.log : null;
  const defaults = failureFirst(run);
  let node = "";
  if (k.route.node) node = ids.has(k.route.node) ? k.route.node : "";
  else if (lg?.node && ids.has(lg.node)) node = lg.node;
  else node = defaults.node || "";
  const stream = STREAMS.some(([v]) => v === k.route.stream) ? k.route.stream
    : STREAMS.some(([v]) => v === lg?.stream) ? lg.stream : defaults.stream;
  return { node, stream, search: String(u.workerSearch ?? lg?.search ?? "").slice(0, 256) };
}

function maxChunk(run) {
  const maximum = run?.log_bounds?.maximum_chunk_bytes;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) return null;
  return Math.min(LOG_READ_BYTES, maximum);
}

async function readLogNow(k, { mode = "start" } = {}) {
  const id = idOf(k);
  const run = runOf(k);
  if (!id || !run) return;
  const u = uiOf(k);
  const ch = channel(k, run);
  if (!ch.node) {
    u.log = { run: id, node: "", stream: ch.stream, search: "", key: "", loading: false, error: null, text: "", segs: [], errors: [], gaps: [], status: "", at: Date.now(), next: 0, cursor: 0 };
    return;
  }
  if (u.log?.loading && mode !== "start" && mode !== "search") return;
  const search = ch.stream === "diagnostic" ? "" : ch.search;
  const key = logKeyOf(id, ch.node, ch.stream, search);
  const prev = u.log?.run === id ? u.log : null;
  const sameKey = Boolean(prev && prev.key === key);
  let cursor = 0;
  if ((mode === "more" || mode === "follow") && sameKey) cursor = prev.next;
  if (mode === "start" || mode === "search") cursor = 0;
  const maximum = maxChunk(run);
  if (maximum === null) {
    u.log = { ...(prev ?? {}), run: id, node: ch.node, stream: ch.stream, search, key, loading: false,
      error: "The run has no valid admitted log-read bound. No read was made.", at: Date.now() };
    return;
  }
  const token = ++u.logToken;
  u.log = { ...(prev ?? {}), run: id, node: ch.node, stream: ch.stream, search, key, loading: true, error: null };
  const query = `node_id=${enc(ch.node)}&stream=${enc(ch.stream)}&cursor=${cursor}&max_bytes=${maximum}${search ? `&q=${enc(search)}` : ""}`;
  let resp;
  try {
    resp = await k.get(`/api/runs/${enc(id)}/logs?${query}`);
  } catch (e) {
    if (token !== u.logToken || idOf(k) !== id) return;
    u.log = { ...u.log, loading: false, error: e?.message ?? String(e), at: Date.now() };
    u.follow = false;
    return;
  }
  if (token !== u.logToken || idOf(k) !== id) return;
  const expectedSource = ch.stream === "diagnostic" ? "native-provider" : "worker-capture";
  if (resp?.node_id !== ch.node || resp?.stream !== ch.stream || typeof resp?.text !== "string" || resp?.source !== expectedSource) {
    u.log = { ...u.log, loading: false, at: Date.now(), error: "The returned log identity does not match the selected node, stream and source. Nothing was substituted." };
    u.follow = false;
    return;
  }
  const returned = Number(resp.cursor);
  const next = Number(resp.next_cursor);
  if (!Number.isSafeInteger(returned) || !Number.isSafeInteger(next) || returned < 0 || next < returned) {
    u.log = { ...u.log, loading: false, at: Date.now(), error: "The service returned a cursor this panel cannot represent exactly. No approximate cursor was used." };
    u.follow = false;
    return;
  }
  const append = Boolean(prev && sameKey && (mode === "more" || mode === "follow") && cursor === prev.next);
  if (append && next < prev.next) {
    u.log = { ...u.log, loading: false, at: Date.now(), error: "The stream cursor moved backwards; automatic following stopped." };
    u.follow = false;
    return;
  }
  const gaps = append ? [...(prev.gaps ?? [])] : [];
  if (resp.gap) gaps.push(`Source reports a log gap${typeof resp.gap === "string" ? `: ${resp.gap}` : ""}. Missing bytes are not reconstructed.`);
  if (returned !== cursor) {
    gaps.push(search ? `Search advanced from cursor ${cursor} to ${returned}; nonmatching bytes are not displayed.`
      : `Source returned cursor ${returned} instead of requested ${cursor}.`);
  }
  if (resp.truncated) gaps.push("Captured output or this read is truncated. Missing bytes are not reconstructed; retained bytes may remain at the next cursor.");
  let text = (append ? prev.text : "") + resp.text;
  if (text.length > LOG_KEEP_CHARS) {
    text = text.slice(-LOG_KEEP_CHARS);
    gaps.push("Older displayed log text was removed at this page's memory bound. Re-read an earlier stream cursor to inspect retained bytes.");
  }
  const errors = errorLines(text);
  const segs = segmentsOf(text, errors);
  const labels = resp.source === "worker-capture" ? "Worker-captured output · byte cursor" : "Native provider diagnostic · native cursor";
  const matches = search && Array.isArray(resp.matches) ? resp.matches : null;
  const searched = search && Number.isSafeInteger(resp.searched_bytes) ? resp.searched_bytes : null;
  let status;
  if (resp.text) {
    status = search && matches
      ? `${matches.length >= 100 ? "100+" : matches.length} matching line${matches.length === 1 ? "" : "s"} · ${searched ?? 0} searched bytes · ${returned} → ${next}`
      : `${labels}. Retained bytes loaded; text is displayed inertly.`;
  } else if (search) {
    status = matches && matches.length
      ? "No further matches at this cursor. Previously loaded matching text is retained."
      : `No line matched “${search}” in ${searched ?? 0} searched bytes. Clear the search to read the stream from the start.`;
  } else {
    status = `No new ${ch.stream} bytes at cursor ${next}. Previously loaded text is retained; an empty read does not imply success or complete logs.`;
    if (ch.stream === "stdout" && !text) status += " Check stderr for compiler/build diagnostics.";
  }
  const fallback = Boolean(!k.route.stream && !prev?.fellBack && isFailedRun(run) && ch.stream === "stderr"
    && mode === "start" && returned === 0 && next === 0 && !resp.text && !search);
  if (ch.stream !== "diagnostic" && search) u.workerSearch = search;
  u.log = {
    run: id, node: ch.node, stream: ch.stream, search, key, loading: false, error: null,
    text, segs, errors, gaps: gaps.slice(-12), status, cursor: returned, next,
    source: resp.source, retained: resp.retained === true, truncated: resp.truncated === true,
    matches, searched, empty: !resp.text, at: Date.now(),
    fellBack: Boolean(prev?.fellBack),
  };
  if (!resp.text && !isRunningRun(run) && u.follow == null) u.autoFollow = false;
  if (fallback) {
    // A failed run's first stderr read retained nothing: read stdout once, as the website does, and say so.
    u.log.fellBack = true;
    u.log.stream = "stdout";
    u.log.key = logKeyOf(id, ch.node, "stdout", search);
    await readLogNow(k, { mode: "start" });
  }
}

function segmentsOf(text, errors) {
  if (!text) return [];
  const lines = text.split("\n");
  const marked = new Set(errors);
  const out = [];
  let buf = [], flag = false;
  const flush = () => { if (buf.length) out.push([flag, buf.join("\n")]); buf = []; };
  for (let i = 0; i < lines.length; i++) {
    const isError = marked.has(i);
    if (buf.length && isError !== flag) flush();
    flag = isError;
    buf.push(lines[i]);
  }
  flush();
  return out;
}

function spawnRead(k, cx, mode) {
  cx.spawn(async (cx) => {
    await readLogNow(k, { mode });
    cx.notify();
  });
}

// The website's Search log: a literal query, at most 256 characters, answered from the start of the retained stream.
export function searchLog(k, cx) {
  const run = runOf(k);
  if (!run) return;
  const u = uiOf(k);
  const ch = channel(k, run);
  if (ch.stream === "diagnostic") {
    k.say("Search is unavailable for native diagnostic streams. The stdout/stderr search is kept.", "info");
    cx.notify();
    return;
  }
  const query = String(k.fields.logq.value() ?? "").trim().slice(0, 256);
  u.workerSearch = query;
  u.log = { ...(u.log?.run === run.id ? u.log : { run: run.id }), run: run.id, node: ch.node, stream: ch.stream, search: query };
  spawnRead(k, cx, query ? "search" : "start");
}

// Called every second while a run is open and on screen: follow the log every 2 s while Follow is on.
export function tick(k, cx) {
  const id = idOf(k);
  if (!id) return;
  const run = runOf(k);
  if (!run) return;
  const u = uiOf(k);
  if (!u.log || u.log.run !== id || u.log.loading || !u.log.key) return;
  const view = k.route.view || "pipeline";
  if (!wantsLog(run, view)) return;
  if (!(u.follow ?? (isRunningRun(run) || u.autoFollow))) return;
  const ch = channel(k, run);
  if (!ch.node) return;
  const key = logKeyOf(id, ch.node, ch.stream, ch.stream === "diagnostic" ? "" : ch.search);
  if (u.log.key !== key) return;
  if (Date.now() - u.log.at < FOLLOW_MS) return;
  if (isRunningRun(run)) u.autoFollow = true;
  spawnRead(k, cx, "follow");
}

// ---- small drawing parts ---------------------------------------------------------------------------------------------------

const monotext = (text, color = null, size = TEXT.id) => div().min_w(0).font_family(MONO).text_size(size)
  .text_color(color ?? theme().foreground).child(String(text ?? ""));

const fieldBox = (t, state, { mono = false, disabled = false } = {}) => {
  const field = Input.new(state).flex_1().min_w(0).text_size(TEXT.label);
  return h_flex().flex_1().min_w(0).h(26).px(8).items_center().rounded(RADIUS.control).border(1).border_color(t.input ?? t.border)
    .when(disabled, (el) => el.opacity(0.5))
    .child(mono ? field.font_family(MONO) : field);
};

const bytesText = (n) => (Number.isSafeInteger(n) && n >= 0 ? `${n.toLocaleString("en-US")} bytes` : NOT_RECORDED);
const yesNo = (v) => (v === true ? "Yes" : v === false ? "No" : NOT_RECORDED);
const capitalize = (s) => (typeof s === "string" && s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);
const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
const textOf = (value) => {
  const text = String(value);
  return text.length > 4000 ? `${text.slice(0, 3999)}…` : text;
};

// The website's pending timing words: a queued run has not started, a running one has no duration yet.
function timing(run) {
  const status = runStatus(run).status;
  const waiting = status === "queued", unfinished = waiting || status === "running";
  const valid = (ms) => Number.isSafeInteger(ms) && ms >= 0;
  return {
    duration: valid(run?.duration_ms) ? formatDuration(run.duration_ms) : waiting ? "Not started" : unfinished ? "In progress" : NOT_RECORDED,
    started: valid(run?.started_at_ms) ? formatRelative(run.started_at_ms) : waiting ? "Not started" : NOT_RECORDED,
    completed: valid(run?.completed_at_ms) ? formatRelative(run.completed_at_ms) : unfinished ? "Not finished" : NOT_RECORDED,
  };
}

// ---- the run header ----------------------------------------------------------------------------------------------------------

export function render(k, cx) {
  const id = idOf(k);
  const out = v_flex().id("kiln-run").gap(10).min_w(0);
  if (!id) return out.child(emptyState("kiln-run-none", "Select a run", "Choose a retained run. Missing or filtered runs are never silently replaced."));
  const key = detailKey(id);
  if (k.waiting(key) && !k.data(key)) return out.child(loadingLine("kiln-run-loading"));
  const run = k.data(key);
  if (!run) {
    return out.child(k.failure(key)
      ? emptyState("kiln-run-missing", "Run not found", `${id}: ${k.failure(key)} No other run was substituted.`)
      : loadingLine("kiln-run-loading"));
  }
  if (k.failure(key)) out.child(errorState("kiln-run-refresh", `Run refresh unavailable: ${k.failure(key)} The shown state may be stale.`));
  out.child(header(k, cx, run));
  out.child(tabs(k, cx));
  const view = k.route.view || "pipeline";
  if (view === "pipeline" || view === "logs") {
    if (view === "pipeline" && !isFailedRun(run)) return out.child(pipeline(k, cx, run));
    if (view === "logs" && !isFailedRun(run)) return out.child(logs(k, cx, run));
    // A failed run shows its log under the pipeline, as the website does at every width.
    return out.child(pipeline(k, cx, run)).child(logs(k, cx, run));
  }
  if (view === "artifacts") return out.child(artifacts(k, cx, run));
  if (view === "tests") return out.child(tests(k, cx, run));
  if (view === "reviews") return out.child(reviews(k, cx, run));
  if (view === "compare") return out.child(compare(k, cx, run));
  if (view === "activity") return out.child(activity(k, cx, run));
  if (view === "evidence") return out.child(evidence(k, cx, run));
  return out.child(pipeline(k, cx, run));
}

function tabs(k, cx) {
  return chips("kiln-run-tabs", VIEWS, k.route.view || "pipeline", (v, cx) => k.go({ view: v }, cx));
}

function header(k, cx, run) {
  const t = theme();
  const s = runStatus(run), retry = retryBadge(run);
  const warnings = runWarnings(run, { stale: k.stale() });
  const body = [];
  body.push(h_flex().flex_wrap().gap(6).items_center()
    .child(pill("kiln-run-pill", s.status, s.label))
    .when(Boolean(run.phase), (el) => el.child(tag("kiln-run-phase", `Phase: ${run.phase}`)))
    .when(Boolean(retry), (el) => el.child(pill("kiln-run-retry", retry.status, retry.label))));
  for (const [i, text] of warnings.entries()) body.push(warningLine(`kiln-run-warning-${i}`, text));
  if (isRunningRun(run)) body.push(progress(k, run, t));
  body.push(facts("kiln-run-facts", [
    ["Source revision", monotext(shortRevision(run.source_revision))],
    ["Created", formatRelative(run.created_at_ms)],
    ["Started", timing(run).started],
    ["Completed", timing(run).completed],
    ["Duration", timing(run).duration],
  ]));
  const why = whyRan(run);
  if (why) body.push(whyBlock(why, t));
  if (run.untrusted) body.push(untrustedBlock(k, cx, run.untrusted, t));
  body.push(identities(k, cx, run, t));
  const controls = controlsBlock(k, cx, run, t);
  if (controls) body.push(controls);
  return card("kiln-run-head", k.projectLabel(run.project_id), null, body);
}

function progress(k, run, t) {
  const p = nodeProgress(run);
  const elapsed = Number.isSafeInteger(run.started_at_ms) ? `Elapsed ${formatDuration(Date.now() - run.started_at_ms)}` : "Elapsed not recorded";
  return v_flex().id("kiln-run-progress").gap(4)
    .child(h_flex().gap(8).items_center()
      .child(words(p.total ? `${p.done} of ${p.total} node${p.total === 1 ? "" : "s"} complete` : "Node progress not recorded", { size: TEXT.label }))
      .child(div().flex_1())
      .child(words(elapsed, { dim: true, size: TEXT.id })))
    .when(p.total > 0, (el) => el.child(meter("kiln-run-progress-bar", p.done / p.total, t.accent)));
}

function whyBlock(why, t) {
  return v_flex().id("kiln-run-why").gap(3)
    .child(div().text_size(TEXT.label).font_medium().child("Why this ran"))
    .when(Boolean(why.changed), (el) => el.child(words(why.changed)))
    .when(why.reasons.length === 0, (el) => el.child(words("No reason was recorded for this run.", { dim: true })))
    .children(why.reasons.map((reason, i) => v_flex().gap(1)
      .child(words(reason.text, { size: TEXT.label }))
      .when(reason.sample.length > 0, (el) => el.child(div().font_family(MONO).text_size(TEXT.id).text_color(t.dim).child(reason.sample.join("\n"))))));
}

function untrustedBlock(k, cx, gate, t) {
  const state = GATE_STATES[gate.state] ?? ["unknown", String(gate.state ?? NOT_RECORDED)];
  const approvedBy = gate.approved_by === null || gate.approved_by === undefined
    ? "Not approved" : gate.approved_by_id && gate.approved_by_id !== gate.approved_by ? `${gate.approved_by} (${gate.approved_by_id})` : gate.approved_by;
  const approved = Number.isSafeInteger(gate.approved_at_ms) ? formatTime(gate.approved_at_ms) : "Not approved";
  const superseded = gate.superseded_by
    ? link("kiln-run-superseded", shortIdentity(gate.superseded_by), (_e, cx) => k.go({ run: gate.superseded_by, view: "pipeline", node: "", stream: "" }, cx))
    : NOT_RECORDED;
  const note = gate.state === "awaiting_approval"
    ? "Nothing runs until an operator approves this exact commit; a new commit needs a new approval."
    : "Approved untrusted runs and their retries run only on untrusted-capable runners, without secrets, workload token or cache.";
  return v_flex().id("kiln-run-untrusted").gap(6).p(8).rounded(RADIUS.control).border(1).border_color(t.border)
    .child(h_flex().gap(8).items_center().flex_wrap()
      .child(div().text_size(TEXT.body).font_medium().child("Untrusted pull request"))
      .child(pill("kiln-run-untrusted-state", state[0], state[1])))
    .child(facts("kiln-run-untrusted-facts", [
      ["Why untrusted", PATH_NOTES[gate.reason] ?? (gate.reason ? String(gate.reason) : NOT_RECORDED)],
      ["Pull request", Number.isSafeInteger(gate.pull_request) ? `#${gate.pull_request}` : NOT_RECORDED],
      ["Head repository", gate.head_repository ?? NOT_RECORDED],
      ["Exact commit", monotext(gate.source_commit ?? NOT_RECORDED)],
      ["Approved by", approvedBy],
      ["Approved commit", gate.approved_commit ?? "Not approved"],
      ["Approved", approved],
      ["Counts for required CI", gate.counts_for_required_ci ? "Yes, for this exact commit only" : "No"],
      ["Superseded by", superseded],
    ]))
    .child(words(`${note} Approving a run is not a code-review approval.`, { dim: true }));
}

function identities(k, cx, run, t) {
  const u = uiOf(k);
  const open = u.ids === true;
  const parent = run.parent_run_id
    ? link("kiln-run-parent", shortIdentity(run.parent_run_id), (_e, cx) => k.go({ run: run.parent_run_id, view: "pipeline", node: "", stream: "" }, cx))
    : NOT_RECORDED;
  return v_flex().id("kiln-run-identities").gap(6)
    .child(link("kiln-run-identities-toggle", open ? "Hide exact source & execution identities" : "Exact source & execution identities",
      (_e, cx) => { u.ids = !open; cx.notify(); }))
    .when(open, (el) => el
      .child(facts("kiln-run-identities-facts", [
        ["Run ID", monotext(run.id)],
        ["Project", run.project_id ?? NOT_RECORDED],
        ["Repository", monotext(run.repository ? JSON.stringify(run.repository) : NOT_RECORDED)],
        ["Source revision", monotext(run.source_revision ?? NOT_RECORDED)],
        ["Canonical tree", monotext(run.canonical_tree ?? NOT_RECORDED)],
        ["Run revision", Number.isSafeInteger(run.revision) ? String(run.revision) : NOT_RECORDED],
        ["Attempt", monotext(run.attempt_id ?? NOT_RECORDED)],
        ["Sequence", Number.isSafeInteger(run.sequence) ? String(run.sequence) : NOT_RECORDED],
        ["Parent run", parent],
        ["Created", formatTime(run.created_at_ms)],
        ["Started", formatTime(run.started_at_ms)],
        ["Completed", formatTime(run.completed_at_ms)],
        ["Affected-set BLAKE3", monotext(run.affected?.set_identity ?? NOT_RECORDED)],
      ]))
      .child(div().text_size(TEXT.label).font_medium().child("Native execution identity"))
      .child(monotext(run.execution ? JSON.stringify(run.execution) : NOT_RECORDED, t.muted)));
}

function controlsBlock(k, cx, run, t) {
  if (!k.canOperate()) return null;
  const disabled = controlsDisabled(k);
  const note = !fresh(k) ? "Snapshot stale or live observation disconnected. Refresh before control."
    : "Only advertised capabilities are enabled. Fresh reads and confirmation bind controls to the exact execution.";
  const label = k.projectLabel(run.project_id);
  const buttons = [];
  if (canCancel(run)) {
    buttons.push(button("kiln-run-cancel", "Cancel run…", { disabled, onClick: (_e, cx) => {
      const w = confirmWords("cancel", label, run);
      k.confirm({ ...w, facts: controlFacts(run), act: (cx) => k.send(`/api/runs/${enc(run.id)}/control`, cancelBody(run),
        { done: "Control response received. Observe admitted state for its result; no success is inferred." }, cx) }, cx);
    } }));
  }
  const gate = run.untrusted;
  if (gate?.state === "awaiting_approval" && gate.source_commit) {
    buttons.push(button("kiln-run-approve", "Approve run…", { disabled, onClick: (_e, cx) => {
      const w = confirmWords("approve", label, run);
      k.confirm({ ...w, facts: [
        ["Run", run.id],
        ["Pull request", Number.isSafeInteger(gate.pull_request) ? `#${gate.pull_request}` : NOT_RECORDED],
        ["Head repository", gate.head_repository ?? NOT_RECORDED],
        ["Exact commit", gate.source_commit],
        ["Why untrusted", PATH_NOTES[gate.reason] ?? String(gate.reason ?? NOT_RECORDED)],
        ["Execution", "Untrusted-capable runner only, without secrets, workload token or cache, including retries"],
        ["Review effect", "None. This is not a code-review approval"],
      ], act: (cx) => k.send(`/api/runs/${enc(run.id)}/approve`, { source_commit: gate.source_commit },
        { done: "Approval admitted for this exact commit. Observe the run for dispatch and its outcome; no success is inferred." }, cx) }, cx);
    } }));
  }
  const status = runStatus(run).status;
  if (status !== "running" && status !== "queued") {
    buttons.push(button("kiln-run-rerun-exact", "Rerun exact…", { disabled, onClick: (_e, cx) => askRerun(k, cx, run, "exact") }));
    if (!run.untrusted) buttons.push(button("kiln-run-rerun-latest", "Run latest…", { disabled, onClick: (_e, cx) => askRerun(k, cx, run, "latest") }));
    if (canRetryFailed(run)) buttons.push(button("kiln-run-rerun-failed", "Retry failed…", { disabled, onClick: (_e, cx) => askRerun(k, cx, run, "failed") }));
  }
  return v_flex().id("kiln-run-controls").gap(6)
    .child(words(note, { dim: true, size: TEXT.id }))
    .child(h_flex().flex_wrap().gap(6).children(buttons));
}

function controlFacts(run) {
  const execution = run.execution;
  return [
    ["Run", run.id],
    ["Source", run.source_revision ?? NOT_RECORDED],
    ["Attempt", run.attempt_id ?? NOT_RECORDED],
    ["Revision", Number.isSafeInteger(run.revision) ? String(run.revision) : NOT_RECORDED],
    ["Sequence", Number.isSafeInteger(run.sequence) ? String(run.sequence) : NOT_RECORDED],
    ["Execution", execution ? `${execution.provider_namespace}:${shortIdentity(execution.native_id)}` : NOT_RECORDED],
  ];
}

function askRerun(k, cx, run, mode) {
  const label = k.projectLabel(run.project_id);
  const w = confirmWords(`rerun-${mode}`, label, run);
  const failed = (run.nodes ?? []).filter((n) => /^(failed|error)$/i.test(String(n?.state ?? ""))).map((n) => n.id).filter(Boolean);
  k.confirm({ ...w, facts: [
    ["Parent run", run.id],
    ["Project", run.project_id ?? NOT_RECORDED],
    ["Mode", mode],
    ["Source", mode === "latest" ? "Latest admitted reference of the project" : run.source_revision ?? NOT_RECORDED],
    ["Failed selection", mode === "failed" ? (failed.length ? failed.join(", ") : "No failed node is recorded") : "None"],
    ["Boundary", "New candidate and attempt; queued durably if project is busy."],
  ], act: (cx) => k.send(`/api/runs/${enc(run.id)}/rerun`, { mode }, {
    done: "New source-bound candidate requested.",
    then: async (data, cx) => {
      if (data?.id) k.go({ run: data.id, view: "pipeline", node: "", stream: "", other: "" }, cx, { replace: true });
    },
  }, cx) }, cx);
}

// ---- Pipeline -------------------------------------------------------------------------------------------------------------------

function pipeline(k, cx, run) {
  const t = theme();
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const edges = Array.isArray(run.edges) ? run.edges : [];
  const topo = pipelineStages(nodes, run.edges);
  const title = run.execution?.provider_namespace === "lattice" ? "Lattice workflow" : "Workflow graph";
  const caption = topo.problem ? `${nodes.length} admitted node(s) · dependency topology unavailable`
    : `${nodes.length} admitted node(s) · ${edges.length} dependency edge(s) · ${topo.stages.length} stage(s)`;
  const selected = k.route.node || "";
  const incoming = relations(edges, "target", "source");
  const outgoing = relations(edges, "source", "target");
  const relationOf = (id) => topo.problem ? "" : id === selected ? "" : (incoming.get(selected) ?? []).includes(id) ? "Prerequisite of selection"
    : (outgoing.get(selected) ?? []).includes(id) ? "Depends on selection" : "";
  const counts = new Map();
  for (const node of nodes) {
    const state = node?.state ? String(node.state) : NOT_RECORDED;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const body = [words(caption, { dim: true })];
  if (counts.size) {
    body.push(h_flex().flex_wrap().gap(4).children([...counts].map(([state, n], i) => {
      const st = nodeStatus(state);
      return tag(`kiln-run-stage-count-${i}`, `${state} · ${n}`, { color: tone(st.status, t) });
    })));
  }
  if (topo.problem) body.push(warningLine("kiln-run-pipeline-problem", topo.problem));
  if (!topo.problem) {
    body.push(v_flex().gap(6).children(topo.stages.map((stage, i) => v_flex().id(`kiln-run-stage-${i}`).gap(3)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(TEXT.label).font_medium().child(`Stage ${i + 1}`))
        .child(words(`${stage.length} node(s) · dependency depth ${i}`, { dim: true, size: TEXT.id })))
      .children(stage.map((node, j) => nodeRow(k, cx, node, t, `kiln-run-stage-${i}-${j}`, relationOf(node.id)))))));
  }
  body.push(nodeInspector(k, cx, run, nodes, topo, incoming, outgoing, t));
  body.push(steps(run, t));
  return card("kiln-run-pipeline", title, null, body);
}

function relations(edges, fromKey, toKey) {
  const map = new Map();
  for (const edge of edges) {
    if (!edge || typeof edge[fromKey] !== "string" || typeof edge[toKey] !== "string") continue;
    const list = map.get(edge[fromKey]) ?? [];
    if (!list.includes(edge[toKey])) list.push(edge[toKey]);
    map.set(edge[fromKey], list);
  }
  return map;
}

function nodeRow(k, cx, node, t, id, relation) {
  const st = nodeStatus(node?.state);
  const duration = Number.isSafeInteger(node?.duration_ms) ? `Recorded duration · ${formatDuration(node.duration_ms)}` : "Duration not recorded";
  const el = v_flex().w_full().min_w(0).px(6).py(4).gap(2)
    .child(h_flex().gap(6).items_center().flex_wrap()
      .child(div().text_size(TEXT.id).text_color(t.dim).child(String(node?.kind ?? "")))
      .child(pill(`${id}-pill`, st.status, st.label)))
    .child(div().text_size(TEXT.body).font_medium().truncate().child(String(node?.id ?? NOT_RECORDED)))
    .child(h_flex().gap(6).items_center()
      .child(words(duration, { dim: true, size: TEXT.id }))
      .when(Boolean(relation), (e) => e.child(words(relation, { dim: true, size: TEXT.id }))));
  return rowLink(id, (cx) => k.go({ node: k.route.node === node?.id ? "" : node?.id }, cx), el)
    .when(node?.id === k.route.node, (e) => e.bg(t.selected));
}

function nodeInspector(k, cx, run, nodes, topo, incoming, outgoing, t) {
  const selected = k.route.node;
  const matches = nodes.filter((node) => node?.id === selected);
  if (!selected) {
    return words(nodes.length ? "Select a node to inspect its recorded state and relationships." : "No workflow nodes are recorded for this run.", { dim: true });
  }
  if (matches.length !== 1) {
    return warningLine("kiln-run-node-missing", `Node unavailable or ambiguous: ${selected}. No other node was substituted.`);
  }
  const node = matches[0];
  const st = nodeStatus(node.state);
  const relationRow = (label, ids) => v_flex().gap(2)
    .child(div().text_size(TEXT.id).text_color(t.dim).child(label))
    .when(!ids.length, (el) => el.child(words("None in the admitted graph.", { dim: true, size: TEXT.id })))
    .children(ids.map((id, i) => link(`kiln-run-${label}-${i}`, id, (_e, cx) => k.go({ node: id }, cx))));
  const inIds = topo.problem ? [] : incoming.get(node.id) ?? [];
  const outIds = topo.problem ? [] : outgoing.get(node.id) ?? [];
  return card("kiln-run-node", node.id, pill("kiln-run-node-state", st.status, st.label), [
    facts("kiln-run-node-facts", [
      ["Kind", node.kind ?? NOT_RECORDED],
      ["Started", Number.isSafeInteger(node.started_at_ms) ? formatTime(node.started_at_ms) : NOT_RECORDED],
      ["Completed", Number.isSafeInteger(node.completed_at_ms) ? formatTime(node.completed_at_ms) : NOT_RECORDED],
      ["Duration", Number.isSafeInteger(node.duration_ms) ? formatDuration(node.duration_ms) : NOT_RECORDED],
    ]),
    topo.problem ? words("Dependency relationships are unavailable; no prerequisites or dependents are inferred.", { dim: true }) : null,
    relationRow("Prerequisites", inIds),
    relationRow("Dependents", outIds),
    h_flex().gap(6).flex_wrap()
      .child(button("kiln-run-node-logs", "Inspect node logs", { onClick: (_e, cx) => k.go({ view: "logs", node: node.id }, cx) }))
      .child(button("kiln-run-node-clear", "Clear node selection", { kind: "plain", onClick: (_e, cx) => k.go({ node: "" }, cx) })),
  ]);
}

function steps(run, t) {
  const records = Array.isArray(run.step_telemetry) ? run.step_telemetry : [];
  if (!records.length) {
    return v_flex().gap(4).child(div().text_size(TEXT.label).font_medium().child("Measured worker steps"))
      .child(words("Not recorded: no worker step measurements were recorded for this execution.", { dim: true }));
  }
  return v_flex().gap(6).child(div().text_size(TEXT.label).font_medium().child("Measured worker steps"))
    .children(records.map((record, i) => {
      const observation = record?.observation ?? {};
      const step = observation.step ?? {};
      const observed = (value, unit) => (Number.isSafeInteger(value) && value >= 0 ? `${value.toLocaleString("en-US")} ${unit}` : NOT_RECORDED);
      return v_flex().id(`kiln-run-step-${i}`).gap(3).p(6).rounded(RADIUS.control).bg(t.raised ?? t.hover)
        .child(div().text_size(TEXT.id).font_medium().child(`${observation.binding?.node_id ?? NOT_RECORDED} · reviewed step ${step.step_index ?? NOT_RECORDED} · sequence ${observation.sequence ?? NOT_RECORDED}`))
        .child(facts(`kiln-run-step-facts-${i}`, [
          ["Started", Number.isSafeInteger(step.started_at_ms) ? formatTime(step.started_at_ms) : NOT_RECORDED],
          ["Completed", Number.isSafeInteger(step.completed_at_ms) ? formatTime(step.completed_at_ms) : NOT_RECORDED],
          ["Measured elapsed", Number.isSafeInteger(step.duration_ms) ? formatDuration(step.duration_ms) : NOT_RECORDED],
          ["Exit code", Number.isSafeInteger(step.exit_code) ? String(step.exit_code) : NOT_RECORDED],
          ["Observed CPU", observed(step.cpu_time_us, "µs")],
          ["Observed peak memory", observed(step.peak_memory_bytes, "bytes")],
        ]))
        .when(Array.isArray(step.cache) && step.cache.length > 0, (el) => el.children(step.cache.map((cache, j) =>
          div().text_size(TEXT.id).text_color(t.dim).child(`Shared cache ${cache?.outcome ?? NOT_RECORDED} · ${observed(cache?.transferred_bytes, "bytes transferred")} · ${Number.isSafeInteger(cache?.duration_ms) ? formatDuration(cache.duration_ms) : NOT_RECORDED} · key ${cache?.key ?? NOT_RECORDED}`))));
    }));
}

// ---- Logs ---------------------------------------------------------------------------------------------------------------------

function logs(k, cx, run) {
  const t = theme();
  const u = uiOf(k);
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const ch = channel(k, run);
  const lg = u.log?.run === run.id ? u.log : null;
  const body = [];
  if (nodes.length) {
    body.push(chips("kiln-log-node", nodes.map((n) => [n.id, n.id]), ch.node, (v, cx) => {
      if (u.log && u.log.node !== v) u.log = null;
      k.go({ node: v }, cx);
    }));
  } else {
    body.push(words("No admitted nodes are recorded for this run. Nothing is read.", { dim: true }));
  }
  if (k.route.node && !nodes.some((n) => n?.id === k.route.node)) {
    body.push(warningLine("kiln-log-node-missing", `Node not found: ${k.route.node}. No other node was substituted.`));
  }
  body.push(h_flex().gap(8).items_center().flex_wrap()
    .child(segmented("kiln-log-stream", STREAMS, ch.stream, (v, _e, cx) => {
      if (u.log && u.log.stream !== v) u.log = null;
      k.go({ stream: v }, cx);
    }))
    .child(toggleSwitch("kiln-log-follow", Boolean(u.follow ?? isRunningRun(run)),
      (next, _e, cx) => { u.follow = next; if (next) spawnRead(k, cx, "follow"); cx.notify(); }, { disabled: !ch.node }))
    .child(words("Follow", { size: TEXT.label })));
  if (ch.stream !== "diagnostic") {
    body.push(h_flex().gap(6).items_center()
      .child(h_flex().flex_1().min_w(0).h(26).px(8).gap(6).items_center().rounded(RADIUS.control).border(1).border_color(t.input ?? t.border)
        .child(svg(icon("search")).size(13).flex_none().text_color(t.dim))
        .child(Input.new(k.fields.logq).flex_1().min_w(0).text_size(TEXT.label)))
      .child(button("kiln-log-search", "Search", { onClick: (_e, cx) => searchLog(k, cx) })));
  } else {
    body.push(words("Search is unavailable for native diagnostic streams. The stdout/stderr search is kept.", { dim: true }));
  }
  body.push(h_flex().gap(6).flex_wrap()
    .child(button("kiln-log-more", "Read more", { disabled: !lg || lg.loading || !lg.key, onClick: (_e, cx) => spawnRead(k, cx, "more") }))
    .child(button("kiln-log-restart", "Read from start", { disabled: !lg || lg.loading || !lg.key, onClick: (_e, cx) => {
      k.fields.logq.set_value("");
      u.workerSearch = "";
      u.log = { ...(lg ?? {}), search: "" };
      spawnRead(k, cx, "start");
    } }))
    .when(Boolean(lg) && Boolean(lg.key), (el) => el.child(button("kiln-log-clear", "Clear displayed log", { kind: "plain",
      disabled: lg.loading,
      onClick: (_e, cx) => {
        u.jumps = false;
        u.log = { ...lg, text: "", segs: [], errors: [], gaps: [], matches: null, searched: null,
          status: "Displayed log cleared. Read from start to read the retained stream again." };
        cx.notify();
      } })))
    .when(ch.stream !== "diagnostic", (el) => el.child(button("kiln-log-download", "Download full retained stream",
      { disabled: !lg || lg.loading || !lg.key, onClick: (_e, cx) => downloadStream(k, cx, ch) }))));
  if (!ch.node) {
    body.push(words("Select an admitted node to read its logs.", { dim: true }));
    return card("kiln-run-logs", "Logs", null, body);
  }
  if (!lg || (lg.loading && !lg.text)) body.push(loadingLine("kiln-log-loading", "Reading retained stream cursor…"));
  if (lg?.error) body.push(errorState("kiln-log-error", `Logs unavailable: ${lg.error} Following stopped; retained displayed bytes may be stale.`));
  if (lg?.fellBack && lg.stream === "stdout") body.push(words("No stderr bytes were retained for this node, so its stdout is shown; choose stderr to return.", { dim: true }));
  for (const [i, gap] of (lg?.gaps ?? []).entries()) body.push(warningLine(`kiln-log-gap-${i}`, gap));
  if (lg?.text) {
    const count = lg.errors.length;
    body.push(h_flex().gap(8).items_center().flex_wrap()
      .when(count > 0, (el) => el
        .child(words(`${count >= 1000 ? "1000+" : count} error line${count === 1 ? "" : "s"}`, { color: red(), size: TEXT.label }))
        .child(button("kiln-log-jump", u.jumps ? "Hide first error lines" : "Jump to first error", { kind: "plain",
          onClick: (_e, cx) => { u.jumps = !u.jumps; cx.notify(); } })))
      .when(count === 0 && isFailedRun(run), (el) => el.child(words("No error-pattern lines in the loaded text", { dim: true, size: TEXT.id }))));
    if (u.jumps && count > 0) body.push(errorSummary(lg, t));
    body.push(logText(lg, t));
  } else if (lg && !lg.loading && !lg.error) {
    body.push(words("No retained bytes are displayed at this cursor.", { dim: true }));
  }
  if (lg?.status) body.push(words(lg.status, { dim: true, size: TEXT.id }));
  if (lg && lg.key) {
    const label = lg.source === "worker-capture" ? "Worker-captured output · byte cursor" : "Native provider diagnostic · native cursor";
    body.push(words(`${label} · ${lg.cursor} → ${lg.next} · retained: ${lg.retained}`, { dim: true, size: TEXT.id }));
  }
  return card("kiln-run-logs", "Logs", null, body);
}

function logText(lg, t) {
  return v_flex().id("kiln-log-text").w_full().max_h(LOG_VIEW_HEIGHT).overflow_y_scrollbar().p(6).gap(0)
    .rounded(RADIUS.control).bg(t.raised ?? t.hover)
    .when(lg.segs.length === 0, (el) => el.child(words("No bytes read yet.", { dim: true })))
    .children(lg.segs.map(([isError, text]) => div().w_full().min_w(0).font_family(MONO).text_size(TEXT.id).line_height("16px")
      .text_color(isError ? red() : t.foreground).child(text)));
}

function errorSummary(lg, t) {
  const lines = lg.text.split("\n");
  const first = lg.errors.slice(0, 8);
  return v_flex().id("kiln-log-errors").gap(2).p(6).rounded(RADIUS.control).border(1).border_color(red())
    .child(words(`First error lines · ${lg.errors.length >= 1000 ? "1000+" : lg.errors.length} marked`, { color: red(), size: TEXT.label }))
    .children(first.map((n, i) => div().id(`kiln-log-error-${i}`).min_w(0).font_family(MONO).text_size(TEXT.id).text_color(red())
      .child(`${n + 1}: ${(lines[n] ?? "").slice(0, 240)}`)))
    .when(lg.errors.length > first.length, (el) => el.child(words(`and ${lg.errors.length - first.length} more error lines in the loaded text`, { dim: true, size: TEXT.id })));
}

function downloadStream(k, cx, ch) {
  const id = idOf(k);
  cx.spawn(async (cx) => {
    try {
      const query = `node_id=${enc(ch.node)}&stream=${enc(ch.stream)}&metadata=true`;
      const meta = await k.get(`/api/runs/${enc(id)}/logs/download?${query}`);
      if (meta?.retained !== true) {
        k.say(`No retained ${ch.stream} stream was reported for node ${ch.node}.`, "error");
      } else {
        k.save(meta.download_path, meta.filename, cx);
      }
    } catch (e) {
      k.say(`Download unavailable: ${e?.message ?? e}`, "error");
    }
    cx.notify();
  });
}

// ---- Artifacts -------------------------------------------------------------------------------------------------------------------

function artifacts(k, cx, run) {
  const key = artifactsKey(run.id);
  const data = k.data(key);
  if (k.waiting(key) && !data) return card("kiln-run-artifacts", "Artifacts", null, loadingLine("kiln-artifacts-loading"));
  if (k.failure(key) && !data) return card("kiln-run-artifacts", "Artifacts", null,
    errorState("kiln-artifacts-error", `Artifact metadata unavailable: ${k.failure(key)} No artifact presence or absence can be inferred.`));
  const list = Array.isArray(data?.artifacts) ? data.artifacts : [];
  if (!list.length) {
    return card("kiln-run-artifacts", "Artifacts", null,
      words("No artifacts have been retained for this run. Logs and execution receipts are not substituted for products.", { dim: true }));
  }
  const body = [words(`${plural(list.length, "retained artifact")}. Downloads require this operator session.`, { dim: true })];
  if (k.failure(key)) body.push(warningLine("kiln-artifacts-refresh", `Artifact refresh unavailable: ${k.failure(key)} The shown list may be stale.`));
  for (const [i, artifact] of list.entries()) {
    body.push(card(`kiln-artifact-${i}`, artifact.name ?? "Artifact", button(`kiln-artifact-download-${i}`, "Download", {
      onClick: (_e, cx) => k.save(`/api/runs/${enc(run.id)}/artifacts/${enc(artifact.id)}`, artifact.name ?? "artifact", cx),
    }), facts(`kiln-artifact-facts-${i}`, [
      ["ID", monotext(artifact.id ?? NOT_RECORDED)],
      ["Node · Attempt", `${artifact.node_id ?? NOT_RECORDED} · ${artifact.attempt_id ?? NOT_RECORDED}`],
      ["Bytes", bytesText(artifact.bytes)],
      ["BLAKE3", monotext(artifact.blake3 ?? NOT_RECORDED)],
    ])));
  }
  return card("kiln-run-artifacts", "Artifacts", null, body);
}

// ---- Tests & coverage --------------------------------------------------------------------------------------------------------------

function tests(k, cx, run) {
  const key = reportsKey(run.id);
  const data = k.data(key);
  if (k.waiting(key) && !data) return card("kiln-run-tests", "Tests & coverage", null, loadingLine("kiln-reports-loading"));
  if (k.failure(key) && !data) return card("kiln-run-tests", "Tests & coverage", null,
    errorState("kiln-reports-error", `Reports unavailable: ${k.failure(key)} No report presence or absence is inferred.`));
  const body = [];
  if (k.failure(key)) body.push(warningLine("kiln-reports-refresh", `Reports refresh unavailable: ${k.failure(key)} The shown reports may be stale.`));
  body.push(summaryCard(data?.summary));
  body.push(flaky(k, data?.flaky_history));
  body.push(words("Reported tests and coverage are recorded evidence, not execution-success or accepted-gate authority. Missing reports are unavailable, not zero failures or full coverage.", { dim: true }));
  const records = Array.isArray(data?.reports) ? data.reports : [];
  if (!records.length) {
    body.push(emptyState("kiln-reports-empty", "No declared reports",
      "No declared reports retained for this run. Structured JUnit, Cobertura or LCOV results appear here once a node retains a declared report."));
  }
  for (const [i, record] of records.entries()) body.push(reportCard(k, cx, run, record, i));
  return card("kiln-run-tests", "Tests & coverage", null, body);
}

function summaryCard(summary) {
  const tests = summary?.tests;
  const coverage = Array.isArray(summary?.coverage) ? summary.coverage : null;
  return card("kiln-run-summary", "Recorded report summary", null, [
    tests ? facts("kiln-run-summary-tests", [
      ["Total", String(tests.total ?? NOT_RECORDED)],
      ["Passed", String(tests.passed ?? NOT_RECORDED)],
      ["Failed", String(tests.failed ?? NOT_RECORDED)],
      ["Errors", String(tests.errors ?? NOT_RECORDED)],
      ["Skipped", String(tests.skipped ?? NOT_RECORDED)],
    ]) : words("Tests: not recorded.", { dim: true }),
    coverage && coverage.length
      ? h_flex().flex_wrap().gap(4).children(coverage.map((row, i) => tag(`kiln-run-cov-${i}`,
        `${row.name ?? row.report_id ?? "report"} · ${coverageWords(row.coverage)}`)))
      : words("Coverage: not recorded.", { dim: true }),
  ]);
}

function coverageWords(coverage) {
  if (!coverage) return NOT_RECORDED;
  const lines = Number.isSafeInteger(coverage.lines_hit) && Number.isSafeInteger(coverage.lines_found) ? `${coverage.lines_hit} / ${coverage.lines_found} lines` : "lines not recorded";
  const rate = typeof coverage.line_rate === "number" ? ` · ${(coverage.line_rate * 100).toFixed(2)}%` : "";
  return `${coverage.format ?? "format"} · ${lines}${rate}`;
}

function reportCard(k, cx, run, record, index) {
  const t = theme();
  const report = record?.report ?? null;
  const kind = report?.kind ?? record?.kind ?? "unavailable";
  const title = `${record?.name ?? "Report"} · ${kind}`;
  const body = [facts(`kiln-report-facts-${index}`, [
    ["Node", record?.node_id ?? NOT_RECORDED],
    ["Attempt", record?.attempt_id ?? NOT_RECORDED],
    ["Source revision", monotext(record?.source_revision ?? NOT_RECORDED)],
    ["Source BLAKE3", monotext(report?.source_blake3 ?? NOT_RECORDED)],
    ["Source bytes", bytesText(report?.source_bytes)],
    ["Report identity", monotext(record?.id ?? NOT_RECORDED)],
    ["Recorded", Number.isSafeInteger(record?.recorded_at_ms) ? formatTime(record.recorded_at_ms) : NOT_RECORDED],
  ])];
  if (record?.unavailable) body.push(warningLine(`kiln-report-unavailable-${index}`, `Report unavailable: ${record.unavailable}. Missing normalized data is not a passing report.`));
  if (record?.artifact) {
    body.push(button(`kiln-report-download-${index}`, "Download retained report source", {
      onClick: (_e, cx) => k.save(`/api/runs/${enc(run.id)}/artifacts/${enc(record.artifact.id)}`, record.artifact.name ?? "report", cx),
    }));
  }
  if (report?.tests) body.push(...testCases(k, cx, record, report.tests, index, t));
  if (report?.coverage) body.push(...coverageBlock(k, cx, record, report.coverage, index, t));
  if (!report?.tests && !report?.coverage && !record?.unavailable) {
    body.push(words(report?.evidence
      ? "No test or coverage content is recorded; this report's evidence is under Evidence."
      : "No test, coverage or evidence content is recorded in this report.", { dim: true }));
  }
  return card(`kiln-report-${index}`, title, null, body);
}

function testCases(k, cx, record, tests, index, t) {
  const u = uiOf(k);
  const out = [facts(`kiln-report-tests-${index}`, [
    ["Total", String(tests.total ?? NOT_RECORDED)],
    ["Passed", String(tests.passed ?? NOT_RECORDED)],
    ["Failed", String(tests.failed ?? NOT_RECORDED)],
    ["Errors", String(tests.errors ?? NOT_RECORDED)],
    ["Skipped", String(tests.skipped ?? NOT_RECORDED)],
    ["Reported duration", typeof tests.duration_seconds === "number" ? formatDuration(tests.duration_seconds * 1000) : NOT_RECORDED],
  ])];
  const cases = Array.isArray(tests.cases) ? tests.cases : [];
  if (!cases.length) out.push(words("No test case is recorded in this report.", { dim: true }));
  for (const [i, test] of cases.entries()) {
    const key = `${record?.id ?? index}:case:${i}`;
    const failedOpen = test.status === "failed" || test.status === "error";
    const open = Object.hasOwn(u.cases, key) ? u.cases[key] : failedOpen;
    const state = CASE_STATES[test.status] ?? ["unknown", capitalize(String(test.status ?? NOT_RECORDED))];
    const head = h_flex().gap(6).items_center().flex_wrap().w_full().min_w(0).py(2)
      .child(pill(`kiln-case-${index}-${i}`, state[0], state[1]))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.label)
        .child(`${test.suite ?? ""} / ${test.class_name ?? ""} / ${test.name ?? NOT_RECORDED}`));
    out.push(v_flex().id(`kiln-report-${index}-case-${i}`).w_full().min_w(0)
      .child(rowLink(`kiln-case-open-${index}-${i}`, (cx) => { u.cases[key] = !open; cx.notify(); }, head))
      .when(open, (el) => el.child(facts(`kiln-case-facts-${index}-${i}`, [
        ["File", test.file ?? NOT_RECORDED],
        ["Line", Number.isSafeInteger(test.line) ? String(test.line) : NOT_RECORDED],
        ["Reported duration", typeof test.duration_seconds === "number" ? formatDuration(test.duration_seconds * 1000) : NOT_RECORDED],
        ["Message", test.message ?? NOT_RECORDED],
      ])).when(Boolean(test.details), (e) => e.child(pre(test.details, t)))));
  }
  return out;
}

function pre(text, t) {
  return div().w_full().min_w(0).max_h(260).overflow_y_scrollbar().p(6).rounded(RADIUS.control).bg(t.raised ?? t.hover)
    .font_family(MONO).text_size(TEXT.id).text_color(t.muted).child(String(text ?? ""));
}

function coverageBlock(k, cx, record, coverage, index, t) {
  const u = uiOf(k);
  const lines = Number.isSafeInteger(coverage.lines_hit) && Number.isSafeInteger(coverage.lines_found) ? `${coverage.lines_hit} / ${coverage.lines_found}` : NOT_RECORDED;
  const branches = Number.isSafeInteger(coverage.branches_hit) && Number.isSafeInteger(coverage.branches_found) ? `${coverage.branches_hit} / ${coverage.branches_found}` : NOT_RECORDED;
  const out = [facts(`kiln-coverage-facts-${index}`, [
    ["Format", coverage.format ?? NOT_RECORDED],
    ["Lines hit / found", lines],
    ["Line rate", typeof coverage.line_rate === "number" ? `${(coverage.line_rate * 100).toFixed(2)}%` : NOT_RECORDED],
    ["Branches hit / found", branches],
    ["Branch rate", typeof coverage.branch_rate === "number" ? `${(coverage.branch_rate * 100).toFixed(2)}%` : NOT_RECORDED],
  ])];
  const files = Array.isArray(coverage.files) ? coverage.files : [];
  for (const [i, file] of files.entries()) {
    const key = `${record?.id ?? index}:cov:${i}`;
    const open = Boolean(u.cases[key]);
    const hit = (file.lines ?? []).filter((line) => (line?.hits ?? 0) > 0).length;
    const found = Array.isArray(file.lines) ? file.lines.length : 0;
    const head = h_flex().gap(8).items_center().w_full().min_w(0).py(2)
      .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(TEXT.id).child(file.path ?? NOT_RECORDED))
      .child(words(`${hit} / ${found}`, { dim: true, size: TEXT.id }));
    out.push(v_flex().id(`kiln-coverage-${index}-${i}`).w_full().min_w(0)
      .child(rowLink(`kiln-coverage-open-${index}-${i}`, (cx) => { u.cases[key] = !open; cx.notify(); }, head))
      .when(open, (el) => el.child(words(uncovered(file), { dim: true, size: TEXT.id }))));
  }
  return out;
}

function uncovered(file) {
  const lines = Array.isArray(file.lines) ? file.lines : [];
  const missing = lines.filter((line) => (line?.hits ?? 0) === 0).map((line) => line.number);
  if (!lines.length) return "No line records are retained for this file.";
  if (!missing.length) return "All recorded lines were hit.";
  const shown = missing.slice(0, 60).join(", ");
  return `Unhit lines: ${shown}${missing.length > 60 ? `, and ${missing.length - 60} more` : ""}.`;
}

function flaky(k, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const body = [words(list.length ? `${list.length} repeated pass/fail instabilit${list.length === 1 ? "y" : "ies"} recorded in the bounded history.`
    : "No repeated pass/fail instability is recorded in the bounded history. This does not prove all tests are stable.", { dim: true })];
  for (const [i, row] of list.entries()) {
    body.push(v_flex().id(`kiln-flaky-${i}`).gap(1).py(3)
      .child(div().text_size(TEXT.label).child(`${row.suite ?? ""} / ${row.class_name ?? ""} / ${row.name ?? NOT_RECORDED}`))
      .child(words(`${row.passed ?? 0} passed · ${row.failed ?? 0} failed · ${row.observations ?? 0} observations · node ${row.node_id ?? NOT_RECORDED} · ${row.report_name ?? NOT_RECORDED}`, { dim: true, size: TEXT.id }))
      .when(Array.isArray(row.run_ids) && row.run_ids.length > 0, (el) => el.child(h_flex().flex_wrap().gap(4).children(row.run_ids.slice(0, 8).map((id, j) =>
        link(`kiln-flaky-run-${i}-${j}`, shortIdentity(id), (_e, cx) => k.go({ run: id, view: "tests", node: "", stream: "" }, cx)))))));
  }
  return card("kiln-run-flaky", "Repeated-test instability", null, body);
}

// ---- Reviews (Patchgate receipts) -------------------------------------------------------------------------------------------------

function reviews(k, cx, run) {
  const key = reportsKey(run.id);
  const data = k.data(key);
  if (k.waiting(key) && !data) return card("kiln-run-reviews", "Reviews", null, loadingLine("kiln-reviews-loading"));
  if (k.failure(key) && !data) return card("kiln-run-reviews", "Reviews", null,
    errorState("kiln-reviews-error", `Reports unavailable: ${k.failure(key)} No review presence or absence is inferred.`));
  const records = Array.isArray(data?.reports) ? data.reports : [];
  const receipts = [], unavailable = [];
  let other = 0;
  for (const record of records) {
    const document = record?.report?.evidence?.document;
    if (document?.schema === "kiln.patchgate.review.v1") receipts.push(record);
    else if (record?.kind === "review" && record?.unavailable) unavailable.push(record);
    else if (record?.kind === "review") other += 1;
  }
  const body = [];
  if (!receipts.length && !unavailable.length) {
    body.push(emptyState("kiln-reviews-empty", "No Patchgate receipt for this run",
      "A review step retains one by uploading its receipt as a review report. A run without a receipt has no recorded review; that is not a clean review."));
  }
  for (const [i, record] of unavailable.entries()) {
    body.push(card(`kiln-review-unavailable-${i}`, "Review report unavailable", null, [
      warningLine(`kiln-review-unavailable-line-${i}`, `Review report unavailable: ${record.unavailable}. No decision is inferred.`),
      words(`The run declared ${record.name ?? "a review report"} on node ${record.node_id ?? NOT_RECORDED}, but its bytes were ${record.unavailable}.`, { dim: true }),
    ]));
  }
  for (const [i, record] of receipts.entries()) body.push(receipt(k, cx, run, record, i));
  if (other) body.push(words(`${plural(other, "review report")} ${other === 1 ? "is" : "are"} not a Patchgate receipt: shown under Tests & coverage.`, { dim: true }));
  return card("kiln-run-reviews", "Reviews", null, body);
}

function decisionOf(value) {
  if (typeof value === "string" && Object.hasOwn(REVIEW_DECISIONS, value)) return { key: value, ...entryOf(value) };
  if (typeof value === "string" && value) {
    const quoted = value.length > 48 ? `${value.slice(0, 47)}…` : value;
    return { key: "unrecognized", status: "unknown", label: `Unrecognized: ${quoted}`, meaning: "Kiln does not recognize this recorded decision. It is shown as recorded and is not read as accepted.", next: "" };
  }
  return { key: "missing", status: "unknown", label: "Not recorded", meaning: "No decision was recorded for this change.", next: "" };
}
function entryOf(key) {
  const [status, label, meaning, next] = REVIEW_DECISIONS[key];
  return { status, label, meaning, next };
}

function nativeReport(document) {
  const empty = { status: "absent", changes: new Map(), records: new Map() };
  if (typeof document?.native_report !== "string") return empty;
  let report;
  try { report = JSON.parse(document.native_report); } catch { return { ...empty, status: "unreadable" }; }
  if (!report || typeof report !== "object") return { ...empty, status: "unreadable" };
  const records = new Map();
  for (const record of Array.isArray(report.records) ? report.records : []) {
    if (typeof record?.hash === "string" && !records.has(record.hash)) records.set(record.hash, record);
  }
  const changes = new Map();
  for (const item of Array.isArray(report.items) ? report.items : []) {
    if (typeof item?.hash !== "string" || changes.has(item.hash)) continue;
    changes.set(item.hash, {
      message: typeof item.message === "string" ? item.message : null,
      paths: Array.isArray(item.paths) ? item.paths.filter((p) => typeof p === "string") : [],
      reason: typeof item.reason === "string" ? item.reason : null,
      needs: Array.isArray(item.needs) ? item.needs.filter((n) => Array.isArray(n) && typeof n[0] === "string") : [],
      record: records.get(item.hash) ?? null,
    });
  }
  return { status: "read", changes, records };
}

function receipt(k, cx, run, record, index) {
  const t = theme();
  const document = record.report.evidence.document;
  const observation = document?.observation ?? {};
  const rows = Array.isArray(observation.reviews) ? observation.reviews : [];
  const native = nativeReport(document);
  const firstHash = rows[0]?.change?.native_id;
  const headline = (typeof firstHash === "string" && native.changes.get(firstHash)?.message) || record.name || "Patchgate receipt";
  const tally = new Map();
  for (const row of rows) {
    const decision = decisionOf(row?.decision);
    const id = decision.key === "unrecognized" ? `unrecognized:${decision.label}` : decision.key;
    const seen = tally.get(id);
    if (seen) seen.count += 1;
    else tally.set(id, { key: decision.key, status: decision.status, label: decision.label, count: 1 });
  }
  const counts = [...tally.values()].sort((a, b) => REVIEW_ORDER.indexOf(a.key) - REVIEW_ORDER.indexOf(b.key));
  const body = [];
  body.push(h_flex().flex_wrap().gap(4).children(counts.map((c, i) => tag(`kiln-receipt-tally-${index}-${i}`, `${c.count} ${c.label}`, { color: tone(c.status, t) }))));
  if (!rows.length) body.push(words("This receipt records no change. An empty receipt is not a clean review.", { dim: true }));
  if (record.artifact) {
    body.push(h_flex().gap(6).flex_wrap().child(button(`kiln-receipt-download-${index}`, "Download exact receipt", {
      onClick: (_e, cx) => k.save(`/api/runs/${enc(run.id)}/artifacts/${enc(record.artifact.id)}`, record.artifact.name ?? "receipt", cx),
    })));
  }
  body.push(facts(`kiln-receipt-facts-${index}`, [
    ["Retained for this run", Number.isSafeInteger(record.recorded_at_ms) ? formatTime(record.recorded_at_ms) : NOT_RECORDED],
    ["Review node", record.node_id ?? NOT_RECORDED],
    ["Source revision", monotext(shortRevision(record.source_revision))],
    ["Report record", monotext(shortIdentity(record.id))],
  ]));
  body.push(words(observation.isolated === true
    ? "Evidence only. This receipt records Patchgate's decisions from an isolated review. It did not accept, merge or release anything, and Kiln did not re-run the review."
    : "Evidence only. This receipt did not accept, merge or release anything, and Kiln did not re-run the review.", { dim: true }));
  if (observation.authorizes_acceptance === true) body.push(warningLine(`kiln-receipt-claims-${index}`, "The producer claims this receipt authorizes acceptance. Kiln grants no acceptance authority from a receipt."));
  if (observation.isolated !== true) body.push(warningLine(`kiln-receipt-isolation-${index}`, "This receipt does not record that the review ran in isolation. Read its decisions as unverified producer claims."));
  if (native.status === "unreadable") body.push(warningLine(`kiln-receipt-native-${index}`, "Patchgate's report in this receipt is not readable JSON. Messages, paths, reasons and times are unavailable; the decisions come from Kiln's admitted observation."));
  if (native.status === "absent") body.push(warningLine(`kiln-receipt-native-${index}`, "This receipt has no Patchgate report. The decisions come from Kiln's admitted observation."));
  for (const [i, row] of rows.entries()) {
    const decision = decisionOf(row?.decision);
    const hash = row?.change?.native_id;
    const change = typeof hash === "string" ? native.changes.get(hash) ?? null : null;
    const decider = change?.record && typeof change.record === "object" ? (change.record.by === "gate" ? "Patchgate rules, no model"
      : change.record.by === "model" ? (change.record.model ? `Model ${change.record.model}` : "A model")
        : change.record.by === "human" ? (change.record.user ? `A person (${change.record.user})` : "A person")
          : String(change.record.by)) : NOT_RECORDED;
    const paths = change ? (change.paths.slice(0, 8).join("\n") || "None recorded") + (change.paths.length > 8 ? `\nand ${change.paths.length - 8} more` : "") : NOT_RECORDED;
    body.push(v_flex().id(`kiln-receipt-change-${index}-${i}`).gap(3).p(6).rounded(RADIUS.control).bg(t.raised ?? t.hover)
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(pill(`kiln-receipt-decision-${index}-${i}`, decision.status, decision.label))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.label).child(change?.message || (hash ? `Change ${shortIdentity(hash)}` : "Change identity not recorded"))))
      .child(words(decision.meaning, { dim: true, size: TEXT.id }))
      .when(Boolean(decision.next), (el) => el.child(words(`Next in Patchgate: ${decision.next}`, { dim: true, size: TEXT.id })))
      .child(facts(`kiln-receipt-change-facts-${index}-${i}`, [
        ["Change", monotext(hash ?? NOT_RECORDED)],
        ["Decided by", decider],
        ["Paths", monotext(paths)],
        ["Reason", change?.reason || change?.record?.reason || NOT_RECORDED],
        ["Prerequisites", change && change.needs.length
          ? monotext(change.needs.map((need) => `${shortIdentity(need[0])} ${decisionOf(need[1]).label}`).join("\n"))
          : change ? "None recorded" : NOT_RECORDED],
      ])));
  }
  return card(`kiln-receipt-${index}`, headline, null, body);
}

// ---- Compare & flaky -----------------------------------------------------------------------------------------------------------------

function compare(k, cx, run) {
  const t = theme();
  const id = run.id;
  const other = k.route.other || "";
  const choices = k.data(choicesKey(id));
  const suggestions = (Array.isArray(choices?.runs) ? choices.runs : []).filter((r) => r?.id && r.id !== id);
  const body = [words("Only admitted recorded facts are compared. Missing tests, coverage and timing stay unavailable. A changed test verdict is not acceptance authority.", { dim: true })];
  body.push(h_flex().gap(6).items_center()
    .child(fieldBox(t, k.fields.other, { mono: true }))
    .child(button("kiln-run-compare-go", "Compare recorded facts", {
      onClick: (_e, cx) => k.go({ other: String(k.fields.other.value() ?? "").trim(), view: "compare" }, cx, { replace: true }),
    })));
  if (k.failure(choicesKey(id)) && !choices) {
    body.push(words(`Run suggestions unavailable: ${k.failure(choicesKey(id))} You can still enter an exact retained run ID.`, { dim: true }));
  } else if (suggestions.length) {
    body.push(v_flex().gap(3).child(div().text_size(TEXT.id).text_color(t.dim).child("Newest retained runs of this project"))
      .children(suggestions.slice(0, 12).map((r, i) => {
        const status = runStatus(r);
        return rowLink(`kiln-run-other-${i}`, (cx) => { k.fields.other.set_value(r.id); k.go({ other: r.id, view: "compare" }, cx, { replace: true }); },
          h_flex().gap(6).items_center().w_full().min_w(0).px(4).py(3)
            .child(pill(`kiln-run-other-pill-${i}`, status.status, status.label))
            .child(div().flex_1().min_w(0).truncate().text_size(TEXT.label).child(r.id))
            .child(words(`${formatRelative(r.created_at_ms)} · ${shortRevision(r.source_revision)}`, { dim: true, size: TEXT.id })));
      })));
  }
  if (!other) {
    body.push(words("Choose another retained run. Missing reports or historical durations remain unavailable, not zero.", { dim: true }));
    return card("kiln-run-compare", "Compare runs & repeated-test instability", null, body);
  }
  const key = compareKey(id, other);
  const data = k.data(key);
  if (k.waiting(key) && !data) {
    body.push(loadingLine("kiln-compare-loading"));
    return card("kiln-run-compare", "Compare runs & repeated-test instability", null, body);
  }
  if (!data) {
    body.push(errorState("kiln-compare-error", `Comparison unavailable: ${k.failure(key) ?? "The service returned no comparison."} No other run was substituted.`));
    return card("kiln-run-compare", "Compare runs & repeated-test instability", null, body);
  }
  const delta = data.duration_ms?.delta;
  const deltaText = Number.isSafeInteger(delta)
    ? `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${formatDuration(Math.abs(delta))}`
    : NOT_RECORDED;
  const outcomePill = (value, label) => {
    const s = outcomeStatus(value);
    return pill(`kiln-compare-${label}-outcome`, s.status, value === "Pending" ? "Pending" : s.label);
  };
  body.push(facts("kiln-compare-facts", [
    ["Current source", monotext(data.source?.current ?? NOT_RECORDED)],
    ["Other source", monotext(data.source?.other ?? NOT_RECORDED)],
    ["Current outcome", outcomePill(data.outcome?.current, "current")],
    ["Other outcome", outcomePill(data.outcome?.other, "other")],
    ["Current duration", Number.isSafeInteger(data.duration_ms?.current) ? formatDuration(data.duration_ms.current) : NOT_RECORDED],
    ["Other duration", Number.isSafeInteger(data.duration_ms?.other) ? formatDuration(data.duration_ms.other) : NOT_RECORDED],
    ["Duration delta (current − other)", deltaText],
  ]));
  body.push(h_flex().gap(10).flex_wrap()
    .child(link("kiln-compare-current", "Inspect current run", (_e, cx) => k.go({ run: data.run_id ?? id, view: "pipeline", node: "", stream: "" }, cx)))
    .child(link("kiln-compare-other", "Inspect compared run", (_e, cx) => k.go({ run: data.other_run_id ?? other, view: "pipeline", node: "", stream: "" }, cx))));
  body.push(v_flex().gap(2)
    .child(div().text_size(TEXT.id).text_color(t.dim).child("Current structured tests & coverage"))
    .child(words(summaryWords(data.reports?.current), { dim: true }))
    .child(div().text_size(TEXT.id).text_color(t.dim).child("Other structured tests & coverage"))
    .child(words(summaryWords(data.reports?.other), { dim: true })));
  body.push(div().text_size(TEXT.label).font_medium().child("Recorded test changes"));
  body.push(words(`Bounded comparison: ${data.test_changes_bounded === true ? "yes" : "not recorded"}. Tests absent on one side are unavailable, not passing.`, { dim: true, size: TEXT.id }));
  const changes = Array.isArray(data.test_changes) ? data.test_changes : [];
  if (!changes.length) body.push(words("No test-status differences recorded in this comparison window.", { dim: true }));
  for (const [i, change] of changes.entries()) {
    body.push(v_flex().id(`kiln-compare-change-${i}`).gap(2).py(3)
      .child(div().text_size(TEXT.label).child(`${change.suite ?? ""} / ${change.class_name ?? ""} / ${change.name ?? NOT_RECORDED}`))
      .child(words(`Node ${change.node_id ?? NOT_RECORDED} · Report ${change.report_name ?? NOT_RECORDED}`, { dim: true, size: TEXT.id }))
      .child(h_flex().gap(6).flex_wrap()
        .child(words("Current:", { dim: true, size: TEXT.id }))
        .child(change.current ? pill(`kiln-compare-cur-${i}`, (CASE_STATES[change.current] ?? ["unknown", capitalize(String(change.current))])[0], (CASE_STATES[change.current] ?? ["unknown", capitalize(String(change.current))])[1]) : words(NOT_RECORDED, { dim: true, size: TEXT.id }))
        .child(words("Other:", { dim: true, size: TEXT.id }))
        .child(change.other ? pill(`kiln-compare-oth-${i}`, (CASE_STATES[change.other] ?? ["unknown", capitalize(String(change.other))])[0], (CASE_STATES[change.other] ?? ["unknown", capitalize(String(change.other))])[1]) : words(NOT_RECORDED, { dim: true, size: TEXT.id }))));
  }
  body.push(flaky(k, data.flaky_history));
  return card("kiln-run-compare", "Compare runs & repeated-test instability", null, body);
}

function summaryWords(summary) {
  const tests = summary?.tests;
  const coverage = Array.isArray(summary?.coverage) ? summary.coverage : [];
  const testText = tests ? `${tests.total ?? 0} total · ${tests.passed ?? 0} passed · ${tests.failed ?? 0} failed · ${tests.errors ?? 0} errors · ${tests.skipped ?? 0} skipped` : "Tests not recorded";
  return `${testText} · ${coverage.length ? `${coverage.length} coverage report${coverage.length === 1 ? "" : "s"}` : "coverage not recorded"}`;
}

// ---- Activity ---------------------------------------------------------------------------------------------------------------------------

function activity(k, cx, run) {
  const u = uiOf(k);
  const key = activityKey(run.id, u.activityCursor);
  const data = k.data(key);
  if (k.waiting(key) && !data) return card("kiln-run-activity", "Activity", null, loadingLine("kiln-activity-loading"));
  if (k.failure(key) && !data) return card("kiln-run-activity", "Activity", null,
    errorState("kiln-activity-error", `Activity unavailable: ${k.failure(key)} No activity is inferred.`));
  const items = Array.isArray(data?.items) ? data.items : [];
  const body = [words(`${items.length} shown of ${data?.total ?? items.length} · bounded retained timeline · audit window: ${data?.audit_window ?? NOT_RECORDED}`, { dim: true, size: TEXT.id })];
  if (k.failure(key)) body.push(warningLine("kiln-activity-refresh", `Activity refresh unavailable: ${k.failure(key)} The shown timeline may be stale.`));
  if (!items.length) body.push(emptyState("kiln-activity-empty", "No retained activity",
    "No retained activity in this bounded page. Audit decisions and canonical events appear here as they are recorded."));
  for (const [i, item] of items.entries()) {
    const open = Boolean(u.fields[`act:${i}`]);
    body.push(v_flex().id(`kiln-activity-item-${i}`).gap(1).py(4).border_b(1).border_color(theme().border)
      .child(div().text_size(TEXT.label).child(activityTitle(item)))
      .child(words(activityMeta(k, item), { dim: true, size: TEXT.id }))
      .child(link(`kiln-activity-fields-${i}`, open ? "Hide recorded fields" : "Recorded fields", (_e, cx) => { u.fields[`act:${i}`] = !open; cx.notify(); }))
      .when(open, (el) => el.child(recordedTree(k, cx, item.kind === "audit" ? item.audit : {
        event_identity: item.event_identity, ordinal: item.ordinal, event_index: item.event_index, event: item.event,
      }, 0, `act-${i}`))));
  }
  body.push(h_flex().gap(8)
    .child(button("kiln-activity-first", "First page", { disabled: !u.activityCursor, onClick: (_e, cx) => { u.activityCursor = ""; u.fields = {}; reloadTab(k, cx); } }))
    .child(button("kiln-activity-next", "Next page", { disabled: !data?.next_cursor, onClick: (_e, cx) => { u.activityCursor = String(data.next_cursor); u.fields = {}; reloadTab(k, cx); } })));
  return card("kiln-run-activity", "Activity", null, body);
}

function reloadTab(k, cx) {
  cx.spawn(async (cx) => { await k.load(cx, { quiet: true }); cx.notify(); });
}

// ---- Evidence ---------------------------------------------------------------------------------------------------------------------------

function evidence(k, cx, run) {
  const key = evidenceKey(run.id);
  const data = k.data(key);
  if (k.waiting(key) && !data) return card("kiln-run-evidence", "Evidence", null, loadingLine("kiln-evidence-loading"));
  if (k.failure(key) && !data) return card("kiln-run-evidence", "Evidence", null,
    errorState("kiln-evidence-error", `Evidence unavailable: ${k.failure(key)} No evidence presence or absence is inferred.`));
  if (!data) return card("kiln-run-evidence", "Evidence", null, words("No evidence response is recorded.", { dim: true }));
  const body = [warningLine("kiln-evidence-boundary",
    "Recorded evidence only. A reported verdict, review, provenance link or retained artifact does not establish accepted gate authority or product correctness.")];
  for (const [name, value] of [["Source linkage", data.source], ["Pipeline linkage", data.pipeline], ["Execution linkage", data.execution]]) {
    const group = name.split(" ")[0].toLowerCase();
    body.push(card(`kiln-evidence-${group}`, name, null,
      value ? recordedTree(k, cx, value, 0, group) : words(NOT_RECORDED, { dim: true })));
  }
  body.push(h_flex().gap(10).flex_wrap()
    .child(link("kiln-evidence-current", "Inspect this exact run", (_e, cx) => k.go({ run: data.run_id ?? run.id, view: "pipeline", node: "", stream: "" }, cx)))
    .when(Boolean(data.parent_run_id), (el) => el.child(link("kiln-evidence-parent", "Inspect parent run",
      (_e, cx) => k.go({ run: data.parent_run_id, view: "pipeline", node: "", stream: "" }, cx)))));
  const arts = Array.isArray(data.artifacts) ? data.artifacts : [];
  body.push(card("kiln-evidence-artifacts", "Retained artifact provenance", null, arts.length
    ? arts.map((artifact, i) => v_flex().id(`kiln-evidence-artifact-${i}`).gap(3).py(3)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.label).font_medium().child(artifact.name ?? "Artifact"))
        .child(button(`kiln-evidence-download-${i}`, "Download", {
          onClick: (_e, cx) => k.save(`/api/runs/${enc(run.id)}/artifacts/${enc(artifact.id)}`, artifact.name ?? "artifact", cx) })))
      .child(recordedTree(k, cx, artifact, 1, `art-${i}`)))
    : [words("No retained artifacts for this run.", { dim: true })]));
  const reports = Array.isArray(data.reports) ? data.reports : [];
  body.push(card("kiln-evidence-reports", "Recorded gate, review and report evidence", null, reports.length
    ? reports.map((record, i) => v_flex().id(`kiln-evidence-report-${i}`).gap(3).py(3)
      .child(div().text_size(TEXT.label).font_medium().child(`${record.name ?? "Report"} · ${record.kind ?? NOT_RECORDED}`))
      .when(record.report?.evidence?.claim_boundary, (el) => el.child(words(record.report.evidence.claim_boundary, { dim: true, size: TEXT.id })))
      .child(recordedTree(k, cx, record.report?.evidence?.document ?? null, 1, `rep-${i}`)))
    : [words("No report with recorded evidence is retained for this run.", { dim: true })]));
  body.push(words(data.claim_boundary ?? "Recorded source, execution and report evidence is not gate acceptance, review approval or release authority", { dim: true }));
  return card("kiln-run-evidence", "Evidence", null, body);
}

// A recorded value as a label/value tree: times as local times, run ids as links, outcomes as pills.
function recordedTree(k, cx, value, depth, prefix) {
  const t = theme();
  if (value === null || value === undefined) return words(NOT_RECORDED, { dim: true });
  if (Array.isArray(value)) {
    if (!value.length) return words("No retained records in this bounded view.", { dim: true });
    const shown = value.slice(0, 50);
    return v_flex().gap(2)
      .children(shown.map((item, i) => (item !== null && typeof item === "object"
        ? v_flex().id(`${prefix}-${depth}-${i}`).gap(2).p(4).rounded(RADIUS.control).bg(t.raised ?? t.hover).child(recordedTree(k, cx, item, depth + 1, `${prefix}-${i}`))
        : rowLabeled(`${prefix}-${depth}-${i}`, `Item ${i + 1}`, item, k, cx, depth, prefix))))
      .when(value.length > shown.length, (el) => el.child(words(`and ${value.length - shown.length} more recorded entries`, { dim: true, size: TEXT.id })));
  }
  if (typeof value !== "object") return words(textOf(value), { size: TEXT.label });
  const rows = Object.entries(value).filter(([, item]) => item !== undefined);
  return v_flex().gap(2).children(rows.map(([key, item], i) => rowLabeled(`${prefix}-${depth}-${i}`, key.replaceAll("_", " "), item, k, cx, depth, prefix, key)));
}

function rowLabeled(id, label, value, k, cx, depth, prefix, key = null) {
  const t = theme();
  const nested = value !== null && typeof value === "object";
  const shown = key ? valueFor(key, value, k, cx, depth, prefix) : (nested
    ? (depth >= 7 ? monotext(boundedJson(value), t.muted) : recordedTree(k, cx, value, depth + 1, prefix))
    : words(textOf(value), { size: TEXT.label }));
  // A nested record goes under its label, indented, so deep records stay inside a narrow panel.
  if (nested) {
    return v_flex().id(id).gap(2).min_w(0)
      .child(div().text_size(TEXT.id).text_color(t.dim).child(label))
      .child(div().ml(2).pl(10).border_l(1).border_color(t.border).min_w(0).child(shown));
  }
  return h_flex().id(id).gap(8).items_start().min_w(0)
    .child(div().w(132).flex_none().text_size(TEXT.id).text_color(t.dim).child(label))
    .child(v_flex().flex_1().min_w(0).items_start().child(shown));
}

function valueFor(key, value, k, cx, depth, prefix) {
  if (value === null || value === undefined) return words(NOT_RECORDED, { dim: true });
  if ((key === "run_id" || key === "parent_run_id") && typeof value === "string") {
    return link(`${prefix}-${depth}-${key}`, shortIdentity(value), (_e, cx) => k.go({ page: "runs", run: value, view: "pipeline", node: "", stream: "" }, cx));
  }
  if (key.endsWith("_at_ms") || key === "next_due_ms") {
    return Number.isSafeInteger(value) ? words(formatTime(value), { size: TEXT.label }) : words(NOT_RECORDED, { dim: true });
  }
  if (key === "duration_ms") return Number.isSafeInteger(value) ? words(formatDuration(value), { size: TEXT.label }) : words(NOT_RECORDED, { dim: true });
  if ((key === "outcome" || key.endsWith("_outcome")) && typeof value === "string" && CANONICAL_OUTCOMES.has(value)) {
    const s = outcomeStatus(value);
    return pill(`${prefix}-${depth}-${key}`, s.status, value === "Pending" ? "Pending" : s.label);
  }
  if (typeof value === "string" && /^web-run-[0-9a-f]{64}$/.test(value)) {
    return link(`${prefix}-${depth}-${key}`, shortIdentity(value), (_e, cx) => k.go({ page: "runs", run: value, view: "pipeline", node: "", stream: "" }, cx));
  }
  if (typeof value === "boolean") return words(yesNo(value), { size: TEXT.label });
  if (value !== null && typeof value === "object") {
    if (depth >= 7) return monotext(boundedJson(value), theme().muted);
    return recordedTree(k, cx, value, depth + 1, `${prefix}-${key}`);
  }
  return words(textOf(value), { size: TEXT.label });
}

function boundedJson(value) {
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  return text.length > 4000 ? `${text.slice(0, 3999)}…` : text;
}
