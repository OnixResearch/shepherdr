// onix: Kiln's run browser (the website's ?page=runs): filter retained runs, pick one to inspect. 25 a page in the
// service's order (newest first unless asked), grouped by the day each started; First page and Next page walk Kiln's
// cursor. Filters: search, project, outcome, exact source revision, order (the website's names and values).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { theme } from "herdr";
import { button, link, segmented, TEXT, RADIUS } from "./ui.js";
import { runsQuery, runsLine, dayGroups, runStatus, retryBadge, formatDuration, formatRelative, shortRevision, shortIdentity, runStart,
  OUTCOME_FILTERS } from "./core/kiln.js";
import { pill, chips, words, emptyState, errorState, loadingLine, rowLink, icon } from "./look.js";

const filtersOf = (r) => ({ q: r.q, project: r.project, outcome: r.outcome, source: r.source, order: r.order, cursor: r.cursor });

export async function load(k) {
  await k.fetch("runs", `/api/runs${runsQuery(filtersOf(k.route))}`);
}

export function render(k, cx, { compact = false } = {}) {
  const t = theme();
  const r = k.route;
  const out = v_flex().id("kiln-runs").gap(8).min_w(0);
  out.child(filters(k, t, compact));
  if (k.waiting("runs")) return out.child(loadingLine("kiln-runs-loading"));
  const page = k.data("runs");
  if (k.failure("runs") && !page) {
    return out.child(errorState("kiln-runs-error", `Run browser unavailable: ${k.failure("runs")} No other page was substituted. Use First page to discard an invalid cursor.`))
      .child(h_flex().child(button("kiln-runs-first", "First page", { onClick: (_e, cx) => k.go({ cursor: "" }, cx, { replace: true }) })));
  }
  const list = page?.runs ?? [];
  out.child(words(runsLine(page, { stale: k.stale() }), { dim: true }));
  if (!list.length) {
    return out.child(emptyState("kiln-runs-empty", "No matching runs", "No runs match these filters. Clear filters or browse another project.",
      button("kiln-runs-clear", "Clear run filters", { onClick: (_e, cx) => clear(k, cx) })));
  }
  for (const [g, group] of dayGroups(list).entries()) {
    out.child(h_flex().pt(4).gap(6).items_center()
      .child(div().text_size(TEXT.label).font_medium().text_color(t.muted).child(group.label))
      .child(div().text_size(TEXT.id).text_color(t.dim).child(`${group.runs.length} run${group.runs.length === 1 ? "" : "s"}`)));
    out.children(group.runs.map((run, i) => row(k, run, t, `kiln-run-${g}-${i}`, compact)));
  }
  return out.child(h_flex().gap(8).pt(4)
    .child(button("kiln-runs-first", "First page", { disabled: !r.cursor, onClick: (_e, cx) => k.go({ cursor: "", run: "" }, cx, { replace: true }) }))
    .child(button("kiln-runs-next", "Next page", { disabled: !page?.next_cursor, onClick: (_e, cx) => k.go({ cursor: page.next_cursor, run: "" }, cx, { replace: true }) })));
}

function clear(k, cx) {
  k.fields.q.set_value("");
  k.fields.source.set_value("");
  k.go({ q: "", project: "", outcome: "", source: "", order: "", cursor: "", run: "" }, cx, { replace: true });
}

// A run's row: its pill (and retry badge), the project and its short id, the revision, how long, when it started.
function row(k, run, t, id, compact) {
  const s = runStatus(run), retry = retryBadge(run);
  const on = k.route.run === run.id;
  const el = v_flex().px(6).py(5).gap(3).min_w(0).when(on, (e) => e.bg(t.selected))
    .child(h_flex().gap(6).items_center().min_w(0)
      .child(pill(`${id}-pill`, s.status, s.label))
      .when(Boolean(retry), (e) => e.child(pill(`${id}-retry`, retry.status, retry.label)))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.body).child(k.projectLabel(run.project_id)))
      .child(div().flex_none().text_size(TEXT.id).text_color(t.dim).child(formatDuration(run.duration_ms))))
    .child(h_flex().gap(8).items_center().min_w(0).text_size(TEXT.id).text_color(t.dim)
      .child(div().flex_none().font_family("JetBrains Mono").child(shortRevision(run.source_revision)))
      .when(!compact, (e) => e.child(div().flex_1().min_w(0).truncate().child(shortIdentity(run.id))))
      .when(compact, (e) => e.child(div().flex_1()))
      .child(div().flex_none().child(`Started ${formatRelative(runStart(run))}`))
      .child(link(`${id}-logs`, "Logs", (_e, cx) => k.go({ run: run.id, view: "logs", node: "", stream: "" }, cx))));
  return rowLink(id, (cx) => k.go({ run: run.id, view: k.route.view || "", node: "", stream: "" }, cx), el);
}

function filters(k, t, compact) {
  const r = k.route;
  const open = k.runFilters === true || Boolean(r.project || r.outcome || r.source || r.order === "asc");
  const projects = (k.data("projects")?.enrolled ?? []).map((p) => [p.id, p.label || p.id]);
  const box = v_flex().id("kiln-run-filters").gap(6)
    .child(h_flex().gap(6).items_center()
      .child(h_flex().flex_1().min_w(0).h(26).px(8).gap(6).items_center().rounded(RADIUS.control).border(1).border_color(t.input ?? t.border)
        .child(svg(icon("search")).size(13).flex_none().text_color(t.dim))
        .child(Input.new(k.fields.q).flex_1().min_w(0).text_size(TEXT.label)))
      .child(button("kiln-runs-apply", "Apply filters", { onClick: (_e, cx) => k.go({ q: k.fields.q.value().trim(), source: k.fields.source.value().trim(), cursor: "", run: "" }, cx, { replace: true }) }))
      .child(link("kiln-runs-more", open ? "Fewer filters" : "More filters", (_e, cx) => { k.runFilters = !open; cx.notify(); })));
  if (!open) return box;
  return box
    .child(div().text_size(TEXT.id).text_color(t.dim).child("Project"))
    .child(chips("kiln-runs-project", [["", "All projects"], ...projects], r.project ?? "", (v, cx) => k.go({ project: v, cursor: "", run: "" }, cx, { replace: true })))
    .child(div().text_size(TEXT.id).text_color(t.dim).child("Outcome"))
    .child(chips("kiln-runs-outcome", OUTCOME_FILTERS.map((o) => [o.value, o.label]), r.outcome ?? "", (v, cx) => k.go({ outcome: v, cursor: "", run: "" }, cx, { replace: true })))
    .child(h_flex().gap(6).items_center()
      .child(h_flex().flex_1().min_w(0).h(26).px(8).items_center().rounded(RADIUS.control).border(1).border_color(t.input ?? t.border)
        .child(Input.new(k.fields.source).flex_1().min_w(0).text_size(TEXT.label).font_family("JetBrains Mono")))
      .child(segmented("kiln-runs-order", [["desc", "Newest first"], ["asc", "Oldest first"]], r.order === "asc" ? "asc" : "desc",
        (v, _e, cx) => k.go({ order: v === "asc" ? "asc" : "", cursor: "", run: "" }, cx, { replace: true }))));
}
