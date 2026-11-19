// onix: Kiln's CI projects (the website's ?page=projects and ?page=project): the enrolled inventory grouped by
// repository, the start-source-bound-run form and repository enrollment, and one project's health, streak, duration
// trend and run history. Two reads for the inventory (GET /api/projects, and GET /api/overview for each card's
// health, the site's own source), one for a project's newest runs (two bounded pages of 50), and the admitted
// references of whichever project the start form holds. Nothing here dispatches without the form's submit.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { theme } from "herdr";
import { button, link, segmented, TEXT, RADIUS } from "./ui.js";
import {
  repositoryGroups, isFailedRun, runStatus, projectHistory, durationPoints, formatDuration, formatRelative, shortRevision,
  shortIdentity, runStart, NOT_RECORDED,
} from "./core/kiln.js";
import { pill, tag, chips, facts, card, words, emptyState, errorState, warningLine, loadingLine, rowLink, tone, MONO } from "./look.js";

const HEALTH = {
  healthy: { status: "success", label: "Passing" },
  failing: { status: "failure", label: "Failing" },
  active: { status: "running", label: "Active" },
  queued: { status: "queued", label: "Queued" },
  unknown: { status: "unknown", label: "Unknown" },
  cancelled: { status: "cancelled", label: "Cancelled" },
  unavailable: { status: "unknown", label: "No retained runs" },
};

const enrolled = (k) => k.data("projects")?.enrolled ?? [];
const available = (k) => k.data("projects")?.available ?? [];
const runsKey = (id) => `project-runs:${id}`;
const refsKey = (id) => `refs:${id}`;

// ---- loading ------------------------------------------------------------------------------------------

export async function load(k, cx, opts = {}) {
  if (k.route.page === "project") {
    const jobs = [k.fetch("projects", "/api/projects")];
    if (k.route.project) jobs.push(loadHistory(k));
    await Promise.all(jobs);
    return;
  }
  await Promise.all([k.fetch("projects", "/api/projects"), k.fetch("overview", "/api/overview")]);
  const s = form(k);
  if (s.project) await loadRefs(k, s.project);
}

async function loadRefs(k, id) {
  await k.fetch(refsKey(id), `/api/projects/${encodeURIComponent(id)}/refs`);
  const refs = k.data(refsKey(id))?.references;
  const s = form(k);
  if (s.project !== id) return;
  if (!s.ref && Array.isArray(refs) && refs.length) s.ref = refs[0]?.reference ?? "";
}

// A project's newest runs: GET /api/runs, then its next cursor once; other projects and duplicates dropped.
async function loadHistory(k) {
  const id = k.route.project;
  const c = (k.cache[runsKey(id)] ??= { data: null, error: null, at: 0, loading: false });
  c.loading = true;
  try {
    const first = await k.get(`/api/runs?project_id=${encodeURIComponent(id)}&limit=50&order=desc`);
    let all = Array.isArray(first?.runs) ? first.runs.slice() : [];
    let total = typeof first?.total === "number" ? first.total : all.length;
    let more = typeof first?.next_cursor === "string" && first.next_cursor;
    if (more) {
      try {
        const second = await k.get(`/api/runs?project_id=${encodeURIComponent(id)}&limit=50&order=desc&cursor=${encodeURIComponent(first.next_cursor)}`);
        if (Array.isArray(second?.runs)) all = all.concat(second.runs);
        if (typeof second?.total === "number") total = second.total;
        more = typeof second?.next_cursor === "string" && Boolean(second.next_cursor);
      } catch {
        // The first page is still admitted state; the streak then says "at least".
      }
    }
    const seen = new Set(), kept = [];
    for (const run of all) {
      if (!run || run.project_id !== id || typeof run.id !== "string" || seen.has(run.id)) continue;
      seen.add(run.id);
      kept.push(run);
      if (kept.length >= 100) break;
    }
    c.data = { runs: kept, total, truncated: kept.length >= 100 || more };
    c.error = null;
    c.at = Date.now();
  } catch (e) {
    if (!c.data) c.error = e?.message ?? String(e);
  } finally {
    c.loading = false;
  }
}

// ---- the start form's state ------------------------------------------------------------------------------

// What the start form holds: the project, the source choice and the chosen admitted reference. It preselects the
// route's `start` (a card's Select for new run, the project page's Run latest) or the only enrolled project.
function form(k) {
  const s = (k.startForm ??= { project: "", mode: "latest", ref: "", applied: "" });
  const list = enrolled(k);
  const wanted = typeof k.route.start === "string" ? k.route.start : "";
  if (wanted && s.applied !== wanted && list.some((p) => p.id === wanted)) {
    s.project = wanted;
    s.ref = "";
    s.applied = wanted;
  }
  if (s.project && list.length && !list.some((p) => p.id === s.project)) s.project = "";
  if (!s.project && list.length === 1) s.project = list[0].id;
  if (!["latest", "ref", "exact"].includes(s.mode)) s.mode = "latest";
  return s;
}

// A project chosen in the form: the route's start hint no longer applies, so it is dropped (a fresh load reads refs).
function pickProject(k, id, cx) {
  const s = form(k);
  if (s.project === id) return;
  s.project = id;
  s.ref = "";
  s.applied = "";
  k.go({ start: "" }, cx, { replace: true });
}

const exactValue = (k) => k.fields.exact.value().trim().toLowerCase();
const exactOk = (k) => /^[0-9a-f]{40}$/.test(exactValue(k));

function submit(k, cx) {
  const s = form(k);
  if (!s.project || k.mutating) return;
  if (s.mode === "ref" && !s.ref) return;
  if (s.mode === "exact" && !exactOk(k)) return;
  const payload = { project_id: s.project };
  if (s.mode === "ref") payload.reference = s.ref;
  if (s.mode === "exact") payload.source_revision = exactValue(k);
  k.send("/api/runs", payload, {
    done: "Run request admitted. Inspect queue, phase and outcome for actual execution state.",
    then: (run, cx) => k.go({ page: "runs", run: run?.id, view: "pipeline" }, cx),
  }, cx);
}

function enroll(k, id, cx) {
  if (!id || k.mutating) return;
  k.send("/api/projects", { project_id: id }, {
    done: "Project enrollment admitted.",
    then: () => { const s = form(k); s.project = id; s.ref = ""; s.applied = typeof k.route.start === "string" ? k.route.start : ""; },
  }, cx);
}

// ---- rendering ---------------------------------------------------------------------------------------------

export function render(k, cx, { wide } = {}) {
  return k.route.page === "project" ? projectPage(k, cx) : projectsPage(k, cx, wide);
}

function projectsPage(k, cx, wide) {
  const t = theme();
  const out = v_flex().id("kiln-projects").gap(10).min_w(0);
  if (k.waiting("projects")) return out.child(loadingLine("kiln-projects-loading"));
  if (k.failure("projects") && !k.data("projects")) {
    return out.child(errorState("kiln-projects-error", `Project inventory unavailable: ${k.failure("projects")} No other project was substituted.`));
  }
  const list = enrolled(k);
  const inventory = !list.length
    ? emptyState("kiln-projects-empty", "No enrolled projects", "Kiln's inventory has no enrolled CI project. Enroll a reviewed repository below.")
    : card("kiln-projects-inventory", `Project inventory · ${list.length}`, null,
      repositoryGroups(list).flatMap((g, gi) => {
        const head = h_flex().id(`kiln-projects-repo-${gi}`).pt(gi ? 6 : 0).gap(6).items_center().min_w(0)
          .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(TEXT.id).text_color(t.muted).child(g.repository ?? "Repository not recorded"))
          .when(g.shared, (el) => el.child(div().flex_none().text_size(TEXT.id).text_color(t.dim).child(`${g.projects.length} projects share this repository`)));
        return [head, ...g.projects.map((p, i) => projectCard(k, cx, p, `kiln-projects-card-${gi}-${i}`))];
      }));
  const note = words("Project actions require operator access. Viewers can browse inventory and retained runs without changing execution.", { dim: true });
  if (!k.canOperate()) return out.child(inventory).child(note);
  // Starting a run is what an operator comes here for, and a card's Select for new run lands here while a panel can't
  // scroll to a form: Start comes first; wide, the forms sit in a column beside the inventory.
  const start = startForm(k, cx, false);
  const repo = enrollForm(k, cx);
  return wide
    ? out.child(h_flex().gap(10).items_start()
      .child(v_flex().flex_1().min_w(0).gap(10).child(inventory).child(note))
      .child(v_flex().w(400).flex_none().gap(10).child(start).child(repo)))
    : out.child(start).child(inventory).child(note).child(repo);
}

function scopeWords(scope) {
  if (!scope || typeof scope !== "object") return "Whole repository";
  const parts = [];
  if (typeof scope.root === "string" && scope.root) parts.push(`Root ${scope.root}`);
  const graphs = Array.isArray(scope.graphs) ? scope.graphs.filter((g) => typeof g === "string") : [];
  if (graphs.length) parts.push(`${graphs.map((g) => (g === "cargo" ? "Cargo" : g === "nix" ? "Nix" : g)).join(", ")} graphs`);
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  const include = count(scope.include), exclude = count(scope.exclude), declared = count(scope.declared_dependencies);
  if (include) parts.push(`${include} include pattern${include === 1 ? "" : "s"}`);
  if (exclude) parts.push(`${exclude} exclude pattern${exclude === 1 ? "" : "s"}`);
  if (declared) parts.push(`${declared} declared dependenc${declared === 1 ? "y" : "ies"}`);
  if (typeof scope.identity === "string" && scope.identity) parts.push(`Scope ${shortIdentity(scope.identity)}`);
  return parts.length ? parts.join(" · ") : "Whole repository";
}

// A project's health line, from the overview the card's pill comes from.
function healthOf(k, id) {
  const ov = k.data("overview");
  if (!ov) return { entry: null, line: k.failure("overview") ? `Health unavailable: ${k.failure("overview")}` : null };
  const entry = (Array.isArray(ov.projects) ? ov.projects : []).find((p) => p.id === id) ?? null;
  if (!entry) return { entry: null, line: "Health not reported for this project." };
  const run = entry.latest_run;
  if (!run) return { entry, line: "No retained runs" };
  const s = runStatus(run);
  if (s.status === "running") return { entry, line: `Started ${formatRelative(run.started_at_ms ?? run.created_at_ms)}` };
  if (s.status === "queued") return { entry, line: `Requested ${formatRelative(run.created_at_ms)}` };
  return { entry, line: `Finished ${formatRelative(run.completed_at_ms ?? run.started_at_ms ?? run.created_at_ms)}` };
}

function projectCard(k, cx, p, id) {
  const t = theme();
  const { entry, line } = healthOf(k, p.id);
  const h = entry ? HEALTH[entry.health] ?? { status: "unknown", label: "Unknown" } : null;
  const open = (k.projOpen ??= {})[p.id] === true;
  const latest = entry?.latest_run ?? null;
  const title = div().id(`${id}-title`).flex_1().min_w(0).truncate().text_size(TEXT.body).font_medium().cursor_pointer()
    .hover((s) => s.text_color(t.accent)).on_click((_e, cx) => k.go({ page: "project", project: p.id }, cx)).child(p.label || p.id);
  const actions = h_flex().gap(8).items_center().flex_wrap()
    .when(Boolean(latest), (el) => el.child(link(`${id}-logs`, "Logs", (_e, cx) => k.go({ page: "runs", run: latest.id, view: "logs", stream: isFailedRun(latest) ? "stderr" : "" }, cx))))
    .child(link(`${id}-runs`, "Browse runs", (_e, cx) => k.go({ page: "runs", project: p.id }, cx)))
    .when(k.canOperate(), (el) => el.child(link(`${id}-start`, "Select for new run", (_e, cx) => k.go({ page: "projects", start: p.id }, cx))))
    .child(link(`${id}-identity`, open ? "Hide repository & pipeline identity" : "Repository & pipeline identity", (_e, cx) => {
      (k.projOpen ??= {})[p.id] = !open;
      cx.notify();
    }));
  return card(id, title, h ? pill(`${id}-health`, h.status, h.label) : tag(`${id}-health`, "Health not reported"), [
    div().font_family(MONO).text_size(TEXT.id).text_color(t.muted).child(p.reference ?? NOT_RECORDED),
    words(line ?? ""),
    words(scopeWords(p.scope), { dim: true }),
    actions,
    ...(open ? [facts(`${id}-facts`, [
      ["ID", p.id],
      ["Repository", p.repository ?? NOT_RECORDED],
      ["Reference", p.reference ?? NOT_RECORDED],
      ["Pipeline", p.pipeline_identity ?? NOT_RECORDED],
    ])] : []),
  ]);
}

function startForm(k, cx, wide) {
  const t = theme();
  const s = form(k);
  const list = enrolled(k);
  const project = list.find((p) => p.id === s.project) ?? null;
  const refsData = s.project ? k.data(refsKey(s.project)) : null;
  const refsErr = s.project ? k.failure(refsKey(s.project)) : null;
  const refs = Array.isArray(refsData?.references) ? refsData.references : [];
  const label = s.mode === "exact" ? "Run exact reachable revision" : s.mode === "ref" ? "Run selected admitted reference" : "Run latest admitted reference";
  const canSubmit = Boolean(project) && !k.mutating && (s.mode !== "ref" || Boolean(s.ref)) && (s.mode !== "exact" || exactOk(k));
  const body = [
    chips("kiln-start-project", list.map((p) => [p.id, p.label || p.id]), s.project, (v, cx) => pickProject(k, v, cx)),
  ];
  if (project) {
    body.push(div().min_w(0).text_size(TEXT.id).text_color(t.dim)
      .child(`${project.repository ?? NOT_RECORDED} · ${project.reference ?? NOT_RECORDED}`));
    body.push(div().min_w(0).text_size(TEXT.id).text_color(t.dim).child(`Pipeline: ${project.pipeline_identity ?? NOT_RECORDED}`));
  } else {
    body.push(words("Enroll or select a project before starting a run.", { dim: true }));
  }
  body.push(div().pt(2).text_size(TEXT.id).text_color(t.dim).child("Source choice"));
  const sources = [["latest", "Latest admitted reference"], ["ref", "Select admitted reference"], ["exact", "Exact reachable revision"]];
  const pickSource = (v, _e, cx) => { form(k).mode = v; cx.notify(); };
  // The three words are long for the side panel: side by side in a big window, wrapped chips in the panel.
  body.push(wide ? segmented("kiln-start-mode", sources, s.mode, pickSource)
    : chips("kiln-start-mode", sources, s.mode, (v, _cx) => pickSource(v, null, _cx)));
  if (s.mode === "ref") {
    if (!s.project) body.push(words("Select a project to read its admitted references.", { dim: true }));
    else if (refsErr && !refsData) body.push(warningLine("kiln-start-refs-error", `Admitted references unavailable: ${refsErr}`));
    else if (!refs.length && !k.waiting(refsKey(s.project))) body.push(words("This project records no admitted reference.", { dim: true }));
    else body.push(chips("kiln-start-ref", refs.map((r) => [r.reference, `${r.reference} · ${shortRevision(r.source_revision)}`]),
      s.ref, (v, cx) => { form(k).ref = v; cx.notify(); }));
  } else if (s.mode === "exact") {
    body.push(h_flex().h(26).px(8).items_center().rounded(RADIUS.control).border(1).border_color(t.input ?? t.border)
      .child(Input.new(k.fields.exact).flex_1().min_w(0).text_size(TEXT.label).font_family(MONO)));
    body.push(words(exactOk(k) ? "Reachability is checked by the service when the run is admitted." : "An exact revision is 40 hexadecimal characters.", { dim: true }));
  }
  body.push(words(s.project && s.mode === "ref" && k.waiting(refsKey(s.project))
    ? "Reading admitted source references…"
    : "Latest resolves the admitted reference when the new run is dispatched; exact revision is reachability-checked by the service.", { dim: true }));
  body.push(words("Only server-admitted repository sources; no commands or paths are supplied here. Busy projects queue durably.", { dim: true }));
  body.push(h_flex().gap(8).items_center().flex_wrap()
    .child(button("kiln-start-submit", label, { kind: "primary", disabled: !canSubmit, onClick: (_e, cx) => submit(k, cx) })));
  return card("kiln-start", "Start source-bound run", null, body);
}

function enrollForm(k, cx) {
  const have = new Set(enrolled(k).map((p) => p.id));
  const open = available(k).filter((p) => !have.has(p.id));
  const chosen = open.some((p) => p.id === k.enrollPick) ? k.enrollPick : open[0]?.id ?? "";
  const body = [
    words("Allowlisted repositories that are not enrolled yet.", { dim: true }),
    words("Allowlisted repository", { dim: true }),
  ];
  if (!open.length) body.push(words("No unenrolled repositories available", { dim: true }));
  else body.push(chips("kiln-enroll-repo", open.map((p) => [p.id, p.label || p.id]), chosen, (_v, cx) => { k.enrollPick = _v; cx.notify(); }));
  body.push(h_flex().gap(8).items_center().flex_wrap()
    .child(button("kiln-enroll-submit", "Enroll project", { disabled: !open.length || k.mutating || !chosen, onClick: (_e, cx) => enroll(k, chosen, cx) })));
  return card("kiln-enroll", "Enroll reviewed repository", null, body);
}

// ---- one project ------------------------------------------------------------------------------------------------

function projectPage(k, cx) {
  const out = v_flex().id("kiln-project").gap(10).min_w(0);
  const id = k.route.project;
  if (!id) {
    return out.child(emptyState("kiln-project-none", "Unknown project", "No CI project was selected. Open one from CI projects.",
      button("kiln-project-to-projects", "CI projects", { onClick: (_e, cx) => k.go({ page: "projects" }, cx) })));
  }
  if (k.waiting("projects")) return out.child(loadingLine("kiln-project-loading"));
  if (k.failure("projects") && !k.data("projects")) {
    return out.child(errorState("kiln-project-inventory", `Project inventory unavailable: ${k.failure("projects")} No other project was substituted.`));
  }
  const p = enrolled(k).find((x) => x.id === id) ?? null;
  if (!p) {
    const invited = available(k).find((x) => x.id === id) ?? null;
    if (!invited) {
      return out.child(emptyState("kiln-project-unknown", "Unknown project",
        `“${id}” is not in Kiln's allowlisted project inventory. No other project was substituted.`,
        button("kiln-project-back", "CI projects", { onClick: (_e, cx) => k.go({ page: "projects" }, cx) })));
    }
    return out.child(h_flex().gap(8).items_center().flex_wrap()
      .child(div().flex_1().min_w(0).text_size(TEXT.title).font_semibold().child(invited.label || invited.id))
      .child(button("kiln-project-back", "CI projects", { onClick: (_e, cx) => k.go({ page: "projects" }, cx) })))
      .child(emptyState("kiln-project-unenrolled", `${invited.label || invited.id} is allowlisted but not enrolled`,
        "Kiln has no retained run history for it. Enroll the repository on CI projects before starting a run.",
        k.canOperate() ? button("kiln-project-enroll", "Enroll on CI projects", { onClick: (_e, cx) => k.go({ page: "projects" }, cx) }) : null));
  }
  const data = k.data(runsKey(id));
  const runs = Array.isArray(data?.runs) ? data.runs : [];
  if (k.canOperate()) {
    out.child(h_flex().justify_end()
      .child(button("kiln-project-run-latest", "Run latest…", { kind: "primary", onClick: (_e, cx) => k.go({ page: "projects", start: id }, cx) })));
  }
  if (!data && k.failure(runsKey(id))) {
    return out.child(errorState("kiln-project-history", `Run history unavailable: ${k.failure(runsKey(id))} No other project's runs were substituted.`));
  }
  if (!data || k.waiting(runsKey(id))) return out.child(loadingLine("kiln-project-history-loading"));
  if (!runs.length) {
    return out.child(emptyState("kiln-project-empty", "No retained runs for this project yet",
      "Kiln has retained no run of this project. Start one from CI projects."));
  }
  const truncated = data.truncated === true;
  const h = projectHistory(runs, { truncated });
  out.child(healthCard(k, p, h, runs, data, `kiln-project-health`));
  out.child(durationCard(k, runs));
  out.child(historyCard(k, id, runs));
  return out;
}

function healthCard(k, p, h, runs, data, id) {
  const latest = h.latest;
  const done = latest ? latest.completed_at_ms ?? latest.started_at_ms ?? latest.created_at_ms : null;
  const streak = h.headline;
  const body = [
    h_flex().gap(6).items_center().flex_wrap()
      .child(pill(`${id}-latest`, latest ? runStatus(latest).status : "unknown", latest ? runStatus(latest).label : "No finished runs yet"))
      .when(h.inProgress > 0, (el) => el.child(tag(`${id}-progress`, `${h.inProgress} in progress`))),
    div().text_size(TEXT.title).font_semibold().child(streak),
    words(h.since === null ? `Latest finished ${formatRelative(done)}` : `Since ${formatRelative(h.since)} · latest finished ${formatRelative(done)}`),
    words(`${p.reference ?? NOT_RECORDED} · ${p.repository ?? NOT_RECORDED} · ${scopeWords(p.scope)}`, { dim: true }),
    h_flex().gap(10).items_start().flex_wrap()
      .child(tile(`${id}-success`, "Last success", h.lastSuccess, "No passing run retained"))
      .child(tile(`${id}-failure`, "Last failure", h.lastFailure, "No failing run retained among the loaded runs")),
    timeline(k, runs, `${id}-timeline`),
    words(`Derived from the newest ${runs.length} retained run${runs.length === 1 ? "" : "s"} of ${data.total ?? runs.length} (at most 2 pages of 50 are read).`, { dim: true }),
  ];
  return card(id, "Health and recent runs", null, body);
}

function tile(id, label, run, none) {
  const t = theme();
  const s = run ? runStatus(run) : null;
  return v_flex().id(id).flex_1().min_w(160).gap(4).p(8).rounded(RADIUS.control).border(1).border_color(t.border)
    .child(div().text_size(TEXT.id).text_color(t.dim).child(label))
    .when(!run, (el) => el.child(words(none, { dim: true })))
    .when(Boolean(run), (el) => el
      .child(h_flex().gap(6).items_center().min_w(0).child(pill(`${id}-pill`, s.status, s.label))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.id).text_color(t.dim).child(formatRelative(run.completed_at_ms ?? run.started_at_ms ?? run.created_at_ms))))
      .child(div().text_size(TEXT.id).text_color(t.dim).child(`${formatDuration(run.duration_ms)} · ${shortRevision(run.source_revision)}`))
      .child(h_flex().gap(8).child(
        link(`${id}-logs`, "Logs", (_e, cx) => k.go({ page: "runs", run: run.id, view: "logs", stream: isFailedRun(run) ? "stderr" : "" }, cx)),
        link(`${id}-pipeline`, "Pipeline", (_e, cx) => k.go({ page: "runs", run: run.id, view: "pipeline" }, cx)))));
}

// Up to 40 status dots, oldest left; each opens that run's pipeline.
function timeline(k, runs, id) {
  const t = theme();
  if (!runs.length) return div();
  const shown = runs.slice(0, 40).reverse();
  return h_flex().id(id).gap(3).items_center().flex_wrap()
    .children(shown.map((run, i) => {
      const s = runStatus(run);
      return div().id(`${id}-${i}`).size(10).flex_none().rounded(5).bg(tone(s.status, t)).border(1).border_color(tone(s.status, t))
        .cursor_pointer().on_click((_e, cx) => k.go({ page: "runs", run: run.id, view: "pipeline" }, cx));
    }));
}

function durationCard(k, runs) {
  const t = theme();
  const { points, excluded } = durationPoints(runs);
  if (!points.length) return card("kiln-project-duration", "Duration trend", null, words("No terminal run has a recorded duration.", { dim: true }));
  const max = Math.max(...points.map((p) => p.ms), 1);
  const sorted = points.map((p) => p.ms).sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
  const caption = [
    ["Latest", points[points.length - 1].ms],
    ["Median", median],
    ["Fastest", sorted[0]],
    ["Slowest", sorted[sorted.length - 1]],
  ];
  return card("kiln-project-duration", "Duration trend", null, [
    h_flex().id("kiln-project-bars").h(56).w_full().gap(2).items_end()
      .children(points.map((p, i) => div().id(`kiln-project-bar-${i}`).flex_1().min_w(2)
        .h(Math.max(3, Math.round(48 * (p.ms / max)))).rounded(2).bg(tone(p.status, t)))),
    words(`${points.length} timed run${points.length === 1 ? "" : "s"} plotted · ${excluded} run${excluded === 1 ? "" : "s"} without recorded timing excluded`, { dim: true }),
    h_flex().gap(12).flex_wrap().children(caption.map(([label, ms]) =>
      v_flex().gap(1).child(div().text_size(TEXT.id).text_color(t.dim).child(label)).child(div().text_size(TEXT.label).child(formatDuration(ms))))),
  ]);
}

function historyCard(k, id, runs) {
  const t = theme();
  const all = link(`${id}-all-runs`, "All runs", (_e, cx) => k.go({ page: "runs", project: id }, cx));
  const rows = runs.slice(0, 20).map((run, i) => {
    const s = runStatus(run);
    const row = v_flex().px(6).py(5).gap(3).min_w(0)
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(pill(`${id}-h-${i}-pill`, s.status, s.label))
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(TEXT.id).text_color(t.muted).child(shortRevision(run.source_revision)))
        .child(div().flex_none().text_size(TEXT.id).text_color(t.dim).child(formatDuration(run.duration_ms))))
      .child(h_flex().gap(8).items_center().min_w(0).text_size(TEXT.id).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(`Started ${formatRelative(runStart(run))}`))
        .child(link(`${id}-h-${i}-logs`, "Logs", (_e, cx) => k.go({ page: "runs", run: run.id, view: "logs", stream: isFailedRun(run) ? "stderr" : "" }, cx)))
        .child(link(`${id}-h-${i}-pipeline`, "Pipeline", (_e, cx) => k.go({ page: "runs", run: run.id, view: "pipeline" }, cx))));
    return rowLink(`${id}-h-${i}`, (cx) => k.go({ page: "runs", run: run.id, view: "pipeline" }, cx), row);
  });
  return card(`${id}-history`, "Run history", all, rows);
}
