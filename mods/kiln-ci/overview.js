// onix: Kiln's Overview page (the website's ?page=overview): failing projects first, then what's in progress, what
// passed, worker capacity and recent activity. Counts cover retained runs only. Three reads, each with its own state.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme } from "herdr";
import { link, TEXT } from "./ui.js";
import { overviewOf, runStatus, formatRelative, formatDuration, shortRevision, isFailedRun } from "./core/kiln.js";
import { pill, card, tone, words, emptyState, errorState, loadingLine, rowLink, icon } from "./look.js";

export async function load(k) {
  await Promise.all([k.fetch("overview", "/api/overview"), k.fetch("workers", "/api/workers"), k.fetch("activity", "/api/activity?limit=5")]);
}

const unavailable = (what, why) => `${what} unavailable: ${why} Nothing is inferred and no sample data is shown.`;

export function render(k, cx, { wide } = {}) {
  const t = theme();
  const out = v_flex().id("kiln-overview").gap(10).min_w(0);
  if (k.waiting("overview")) return out.child(loadingLine("kiln-ov-loading"));
  if (k.failure("overview") && !k.data("overview")) return out.child(errorState("kiln-ov-error", unavailable("Project health", k.failure("overview"))));
  const ov = overviewOf(k.data("overview"));
  if (!ov.total) {
    return out.child(emptyState("kiln-ov-empty", "No projects configured", "Kiln has no CI projects yet. Enroll one on CI projects.",
      link("kiln-ov-to-projects", "CI projects", (_e, cx) => k.go({ page: "projects" }, cx))));
  }
  out.child(hero(k, ov, t));
  out.child(attention(k, ov, t));
  const progress = unresolved(k, ov, t), passed = recentlyPassed(k, ov, t);
  if (ov.busy) out.child(progress ?? div()).child(passed);
  else out.child(passed).child(progress ?? div());
  const side = [workersCard(k, t), activityCard(k, t)];
  return wide ? out.child(h_flex().gap(10).items_start().children(side.map((c) => div().flex_1().min_w(0).child(c)))) : out.children(side);
}

function hero(k, ov, t) {
  const failing = ov.failing.length;
  const head = `${failing} failing of ${ov.total} project${ov.total === 1 ? "" : "s"}`;
  const summary = failing ? "Latest retained run per project. Failing projects are listed first below." : "No project's latest retained run failed.";
  const excluded = [ov.excluded.unknown && `${ov.excluded.unknown} unknown`, ov.excluded.cancelled && `${ov.excluded.cancelled} cancelled`,
    ov.excluded.none && `${ov.excluded.none} without a retained run`].filter(Boolean);
  const d = ov.denominator || 1;
  const p = ov.passed.length, f = failing, a = d - p - f;
  return card("kiln-ov-hero", null, null, [
    h_flex().gap(8).items_center()
      .child(svg(icon(failing ? "circle-x" : "circle-check")).size(18).flex_none().text_color(tone(failing ? "failure" : "success")))
      .child(div().text_size(TEXT.title).font_semibold().child(head)),
    words(summary),
    h_flex().gap(8).items_center()
      .child(div().text_size(TEXT.label).text_color(t.muted).child("Pass rate of latest project runs"))
      .child(div().text_size(TEXT.body).font_semibold().child(ov.passRate === null ? "Unavailable" : `${ov.passRate}%`)),
    h_flex().id("kiln-ov-bar").w_full().h(8).rounded(4).bg(t.border)
      .when(ov.denominator > 0, (el) => el
        .child(div().h_full().w(`${(p * 100) / d}%`).bg(tone("success")))
        .child(div().h_full().w(`${(f * 100) / d}%`).bg(tone("failure")))
        .child(div().h_full().w(`${(Math.max(0, a) * 100) / d}%`).bg(tone("running")))),
    words(ov.denominator ? `${p} passed of ${ov.denominator} latest project runs that passed, failed or are in progress.` : "No latest project run passed, failed or is in progress.", { dim: true }),
    words(excluded.length ? `Excluded from the rate: ${excluded.join(", ")}.` : "No latest project run is excluded from the rate.", { dim: true }),
    h_flex().id("kiln-ov-chips").flex_wrap().gap(6).children(ov.chips.map((c) =>
      rowLink(`kiln-ov-chip-${c.id}`, (cx) => k.go(c.go, cx), h_flex().h(24).px(8).gap(6).items_center().border(1).border_color(t.border)
        .child(div().text_size(TEXT.label).text_color(t.muted).child(c.label))
        .child(div().text_size(TEXT.label).font_semibold().text_color(c.count && c.status !== "neutral" ? tone(c.status) : t.foreground).child(String(c.count)))))),
  ]);
}

// One project's line: its latest run's pill, the project, when, and Logs / Pipeline for that exact run.
function projectRow(k, p, t, id, when) {
  const r = p.latest_run;
  const s = r ? runStatus(r) : { status: "unknown", label: "No retained runs" };
  return h_flex().id(id).gap(8).items_center().min_w(0).py(3)
    .child(pill(`${id}-pill`, s.status, s.label))
    .child(div().id(`${id}-name`).flex_1().min_w(0).truncate().text_size(TEXT.body).cursor_pointer().hover((st) => st.text_color(t.accent))
      .on_click((_e, cx) => k.go({ page: "project", project: p.id }, cx)).child(p.label || p.id))
    .child(div().flex_none().text_size(TEXT.id).text_color(t.dim).child(when))
    .when(Boolean(r), (el) => el
      .child(link(`${id}-logs`, "Logs", (_e, cx) => k.go({ page: "runs", run: r.id, view: "logs", stream: isFailedRun(r) ? "stderr" : "" }, cx)))
      .child(link(`${id}-pipe`, "Pipeline", (_e, cx) => k.go({ page: "runs", run: r.id, view: "pipeline" }, cx))));
}

function attention(k, ov, t) {
  const body = ov.failing.length
    ? ov.failing.map((p, i) => {
      const r = p.latest_run;
      return v_flex().gap(2).child(projectRow(k, p, t, `kiln-ov-fail-${i}`, `Finished ${formatRelative(r?.completed_at_ms)}`))
        .child(div().pl(4).text_size(TEXT.id).text_color(t.dim).child(`Duration ${formatDuration(r?.duration_ms)} · Revision ${shortRevision(r?.source_revision)}`));
    })
    : [words("Nothing needs attention: no project's latest run failed.", { dim: true })];
  return card("kiln-ov-attention", `Needs attention · ${ov.failing.length}`, null, body);
}

function unresolved(k, ov, t) {
  if (!ov.unresolved.length) return null;
  return card("kiln-ov-progress", `In progress & unresolved · ${ov.unresolved.length}`, null, ov.unresolved.map((p, i) => {
    const r = p.latest_run;
    const when = !r ? "—" : r.phase === "active" ? `Started ${formatRelative(r.started_at_ms)}` : r.phase === "queued" ? `Requested ${formatRelative(r.created_at_ms)}`
      : `Finished ${formatRelative(r.completed_at_ms)}`;
    return projectRow(k, p, t, `kiln-ov-prog-${i}`, when);
  }));
}

function recentlyPassed(k, ov, t) {
  const body = ov.passed.length
    ? ov.passed.map((p, i) => projectRow(k, p, t, `kiln-ov-pass-${i}`, `${formatDuration(p.latest_run?.duration_ms)} · ${formatRelative(p.latest_run?.completed_at_ms)}`))
    : [words("No passing projects.", { dim: true })];
  return card("kiln-ov-passed", `Recently passed · ${ov.passed.length}`, null, body);
}

function workersCard(k, t) {
  const right = link("kiln-ov-all-workers", "All workers", (_e, cx) => k.go({ page: "workers" }, cx));
  if (k.waiting("workers")) return card("kiln-ov-workers", "Workers", right, loadingLine("kiln-ov-w-loading"));
  if (k.failure("workers") && !k.data("workers")) return card("kiln-ov-workers", "Workers", right, errorState("kiln-ov-w-error", unavailable("Worker capacity", k.failure("workers"))));
  const w = k.data("workers"), s = w?.summary ?? {};
  const counts = {};
  for (const x of w?.workers ?? []) counts[x.status] = (counts[x.status] ?? 0) + 1;
  const tile = (label, value) => v_flex().flex_1().min_w(80).gap(2)
    .child(div().text_size(TEXT.id).text_color(t.dim).child(label)).child(div().text_size(TEXT.body).font_semibold().child(String(value ?? 0)));
  return card("kiln-ov-workers", `Workers · ${s.targets ?? 0} target${s.targets === 1 ? "" : "s"}`, right, [
    h_flex().flex_wrap().gap(8).child(tile("Free project slots", s.free_slots)).child(tile("Active / occupied", s.active))
      .child(tile("Configured slots", s.configured_slots)).child(tile("Queued runs", s.queued)),
    words(Object.entries(counts).map(([k2, n]) => `${n} ${k2.replace(/_/g, " ")}`).join(" · ") || "No targets.", { dim: true }),
    words("Configured targets and admission slots, not discovered machines. Physical liveness is unknown.", { dim: true }),
  ]);
}

// An activity item's title: an audited request ("POST /api/runs · accepted") or a run's event ("Run started").
export function activityTitle(item) {
  if (item?.kind === "audit") return `${item.audit?.method ?? ""} ${item.audit?.target ?? ""} · ${item.audit?.decision ?? ""}`.trim();
  const name = item?.event && typeof item.event === "object" ? Object.keys(item.event)[0] : String(item?.event ?? "Event");
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/ (\w)/g, (_m, c) => ` ${c.toLowerCase()}`);
}
export function activityMeta(k, item) {
  return [item?.kind, item?.project_id && k.projectLabel(item.project_id), item?.audit?.actor_label, formatRelative(item?.recorded_at_ms)].filter(Boolean).join(" · ");
}

function activityCard(k, t) {
  const a = k.data("activity");
  const title = a ? `Recent activity · ${a.items?.length ?? 0} of ${a.total ?? 0}` : "Recent activity";
  if (k.waiting("activity")) return card("kiln-ov-activity", title, null, loadingLine("kiln-ov-a-loading"));
  if (k.failure("activity") && !a) return card("kiln-ov-activity", title, null, errorState("kiln-ov-a-error", unavailable("Recent activity", k.failure("activity"))));
  const items = a?.items ?? [];
  if (!items.length) return card("kiln-ov-activity", title, null, words("No recorded activity.", { dim: true }));
  return card("kiln-ov-activity", title, null, items.map((item, i) => {
    const row = v_flex().gap(1).px(4).py(3).min_w(0)
      .child(div().min_w(0).truncate().text_size(TEXT.label).child(activityTitle(item)))
      .child(div().min_w(0).truncate().text_size(TEXT.id).text_color(t.dim).child(activityMeta(k, item)));
    return item.run_id ? rowLink(`kiln-ov-act-${i}`, (cx) => k.go({ page: "runs", run: item.run_id, view: "activity" }, cx), row) : row.id(`kiln-ov-act-${i}`);
  }));
}
