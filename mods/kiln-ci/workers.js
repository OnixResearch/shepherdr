// onix: Kiln's execution targets (the website's ?page=workers): the project admission slots summary, the register of
// configured targets with its client-side search and slot-state filter, and one target's slots, latest execution,
// heartbeat and assigned projects. One read, GET /api/workers, the bounded snapshot the site reads (schema, bounded
// and storage_failed checked before anything is drawn); the inventories and campaigns the website shares the page
// with are outside this panel. Filtering never substitutes a target: the register is the snapshot, narrowed.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { theme } from "herdr";
import { button, link, TEXT, RADIUS } from "./ui.js";
import {
  WORKER_STATUS, workerStatus, workerLabel, heartbeatLabel, runStatus, formatRelative, formatTime, shortRun, NOT_RECORDED,
} from "./core/kiln.js";
import { pill, tag, chips, facts, card, words, emptyState, loadingLine, rowLink, icon, tone, MONO } from "./look.js";

const SCHEMA = "kiln.web-workers.v1";

export async function load(k, cx, opts = {}) {
  await k.fetch("workers", "/api/workers");
}

// The snapshot, or the reason it can't stand in for one (the site rejects a wrong schema or an unbounded read).
function inventory(k) {
  const d = k.data("workers");
  if (!d) return { error: k.failure("workers") ?? "No worker snapshot was read." };
  if (d.schema !== SCHEMA) return { error: "The reply is not a worker snapshot this panel reads." };
  if (d.bounded !== true) return { error: "The reply is not a bounded snapshot of the worker inventory." };
  if (d.storage_failed === true) return { error: "Kiln could not read its stored worker inventory." };
  if (!Array.isArray(d.workers)) return { error: "The reply carries no list of worker targets." };
  return { data: d };
}

export function title(k) {
  const w = (k.data("workers")?.workers ?? []).find((x) => x?.id === k.route.worker);
  return w ? workerLabel(w) : "Workers";
}

export function render(k, cx, { wide } = {}) {
  const out = v_flex().id("kiln-workers").gap(10).min_w(0);
  if (k.waiting("workers")) return out.child(loadingLine("kiln-workers-loading"));
  const inv = inventory(k);
  if (inv.error) return out.child(unavailable(k, cx, inv.error));
  const data = inv.data;
  return k.route.worker ? target(k, cx, data, wide) : register(k, cx, data);
}

function unavailable(k, cx, why) {
  return emptyState("kiln-workers-unavailable", "Workers unavailable",
    `${why} Nothing is inferred and no sample data is shown.`,
    button("kiln-workers-retry", "Try again", { onClick: (_e, cx) => { cx.spawn(async (cx) => { await load(k, cx); cx.notify(); }); } }));
}

function metric(label, value) {
  const t = theme();
  return v_flex().flex_1().min_w(72).gap(2)
    .child(div().text_size(TEXT.id).text_color(t.dim).child(label))
    .child(div().text_size(TEXT.body).font_semibold().child(String(value ?? 0)));
}

// ---- the register -------------------------------------------------------------------------------------------------

function register(k, cx, data) {
  const out = v_flex().id("kiln-workers-register-page").gap(10).min_w(0);
  const s = data.summary ?? {};
  out.child(card("kiln-workers-summary", "Project admission slots", null, [
    div().text_size(TEXT.body).font_medium().child(`${s.targets ?? 0} targets · ${s.enrolled_slots ?? 0}/${s.configured_slots ?? 0} slots enrolled`),
    h_flex().gap(8).flex_wrap().child(metric("Occupied", s.active)).child(metric("Free slots", s.free_slots)).child(metric("Queued runs", s.queued)),
    words("Free slots do not mean online workers.", { dim: true }),
  ]));
  out.child(registerCard(k, cx, data, "kiln-workers-register"));
  return out;
}

function registerCard(k, cx, data, id) {
  const t = theme();
  const all = data.workers ?? [];
  const q = k.fields.workerq.value().trim().toLowerCase();
  const status = k.route.worker_status ?? "";
  const matches = (w) => {
    if (status && w?.status !== status) return false;
    if (!q) return true;
    const hay = [w?.id, w?.provider_profile_id, w?.platform, ...(w?.projects ?? []).flatMap((p) => [p?.id, p?.label])]
      .filter(Boolean).join("\n").toLowerCase();
    return hay.includes(q);
  };
  const shown = all.filter(matches).sort((a, b) => workerLabel(a).localeCompare(workerLabel(b), undefined, { sensitivity: "base" }));
  const filtered = Boolean(q || status);
  const clear = (_e, cx) => {
    k.fields.workerq.set_value("");
    k.go({ worker_status: "", worker: "" }, cx, { replace: true });
  };
  const body = [
    h_flex().gap(6).items_center()
      .child(h_flex().flex_1().min_w(0).h(26).px(8).gap(6).items_center().rounded(RADIUS.control).border(1).border_color(t.input ?? t.border)
        .child(svg(icon("search")).size(13).flex_none().text_color(t.dim))
        .child(Input.new(k.fields.workerq).flex_1().min_w(0).text_size(TEXT.label))),
    div().text_size(TEXT.id).text_color(t.dim).child("Slot state"),
    chips(`${id}-status`, [["", "All states"], ...Object.entries(WORKER_STATUS).map(([value, w]) => [value, w.label])], status,
      (v, cx) => k.go({ worker_status: v, worker: "" }, cx, { replace: true })),
    h_flex().gap(8).items_center().flex_wrap()
      .child(div().flex_1().min_w(0).text_size(TEXT.label).text_color(t.muted)
        .child(filtered ? `${shown.length} of ${all.length} targets · project name A–Z` : `${all.length} targets · project name A–Z`))
      .when(filtered, (el) => el.child(link(`${id}-clear`, "Clear filters", clear))),
  ];
  if (!all.length) body.push(words("No execution targets are configured.", { dim: true }));
  else if (!shown.length) body.push(words("No target matches these filters.", { dim: true }));
  else body.push(...shown.map((w, i) => row(k, w, `${id}-${i}`)));
  return card(id, "Execution targets", null, body);
}

function hbText(hb) {
  return div().flex_none().text_size(TEXT.id).text_color(tone(hb.status)).whitespace_nowrap().child(hb.label);
}

// A target: its name over provider and platform, then slots, heartbeat, queue and its latest execution.
function row(k, w, id) {
  const t = theme();
  const s = workerStatus(w), hb = heartbeatLabel(w), cap = w.capacity ?? {};
  const latest = w.latest_run ?? null;
  const el = v_flex().px(6).py(6).gap(3).min_w(0)
    .child(h_flex().gap(8).items_center().min_w(0)
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.body).child(workerLabel(w)))
      .child(pill(`${id}-slots`, s.status, s.label)))
    .child(h_flex().gap(8).items_center().min_w(0).text_size(TEXT.id).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(`${w.provider_profile_id ?? NOT_RECORDED} · ${w.platform ?? NOT_RECORDED}`))
      .child(hbText(hb)))
    .child(h_flex().gap(8).items_center().min_w(0).text_size(TEXT.id).text_color(t.dim)
      .when(cap.queued > 0, (e) => e.child(div().flex_none().child(`Queued ${cap.queued}`)))
      .when(Boolean(latest), (l) => {
        const rs = runStatus(latest);
        return l.flex_1().min_w(0).gap(4).items_center()
          .child(pill(`${id}-latest`, rs.status, rs.label))
          .child(div().flex_none().child(formatRelative(latest.completed_at_ms ?? latest.started_at_ms ?? latest.created_at_ms)))
          .child(div().flex_1().min_w(0).truncate().child(k.projectLabel(latest.project_id)));
      })
      .when(!latest, (l) => l.child("No recorded execution")));
  return rowLink(id, (cx) => k.go({ page: "workers", worker: w.id }, cx), el);
}

// ---- one target -------------------------------------------------------------------------------------------------

function target(k, cx, data, wide) {
  const t = theme();
  const id = k.route.worker;
  const w = (data.workers ?? []).find((x) => x?.id === id) ?? null;
  if (!w) {
    return v_flex().id("kiln-worker").gap(10).min_w(0)
      .child(h_flex().child(link("kiln-worker-back", "All targets", (_e, cx) => k.go({ worker: "" }, cx))))
      .child(emptyState("kiln-worker-missing", "This exact target is not in the current inventory.",
        "No other target was substituted."));
  }
  const s = workerStatus(w), hb = heartbeatLabel(w), cap = w.capacity ?? {};
  const latest = w.latest_run ?? null;
  const out = v_flex().id("kiln-worker").gap(10).min_w(0);
  out.child(h_flex().items_center()
    .child(link("kiln-worker-back", "All targets", (_e, cx) => k.go({ worker: "" }, cx))));
  out.child(card("kiln-worker-head", workerLabel(w), pill("kiln-worker-status", s.status, s.label), [
    div().text_size(TEXT.label).text_color(t.muted).child(s.meaning),
    h_flex().gap(10).items_center().flex_wrap()
      .child(tag("kiln-worker-heartbeat", hb.label, { color: tone(hb.status) }))
      .child(div().text_size(TEXT.id).text_color(t.dim).child(`${w.provider_profile_id ?? NOT_RECORDED} · ${w.platform ?? NOT_RECORDED}`)),
    words(`${cap.enrolled_slots ?? 0} of ${cap.configured_slots ?? 0} configured project slots enrolled.`),
    h_flex().gap(8).flex_wrap().child(metric("Occupied", cap.active)).child(metric("Free slots", cap.free_slots)).child(metric("Queued runs", cap.queued)),
  ]));
  out.child(latestCard(k, w, latest, "kiln-worker-latest"));
  const beat = heartbeatCard(w, hb, "kiln-worker-hb"), binding = bindingCard(w, "kiln-worker-binding");
  if (wide) {
    out.child(h_flex().gap(10).items_start()
      .child(div().flex_1().min_w(0).child(beat)).child(div().flex_1().min_w(0).child(binding)));
  } else {
    out.child(beat).child(binding);
  }
  out.child(projectsCard(k, w, "kiln-worker-projects"));
  const open = k.workerBrowse === true;
  out.child(h_flex().justify_end()
    .child(link("kiln-worker-browse", open ? "Hide targets" : `Browse ${(data.workers ?? []).length} targets`, (_e, cx) => { k.workerBrowse = !open; cx.notify(); })));
  if (open) out.child(registerCard(k, cx, data, "kiln-worker-browse-register"));
  return out;
}

function latestCard(k, w, latest, id) {
  const t = theme();
  if (!latest) return card(id, "Latest execution", null, words("No recorded execution for this target.", { dim: true }));
  const s = runStatus(latest);
  const open = (k.workerOpen ??= {})[id] === true;
  const when = latest.completed_at_ms ? `Finished ${formatRelative(latest.completed_at_ms)}`
    : latest.started_at_ms ? `Started ${formatRelative(latest.started_at_ms)}` : `Requested ${formatRelative(latest.created_at_ms)}`;
  return card(id, "Latest execution", link(`${id}-exact`, "Open exact run", (_e, cx) => k.go({ page: "runs", run: latest.id, view: "pipeline" }, cx)), [
    h_flex().gap(8).items_center().flex_wrap()
      .child(pill(`${id}-pill`, s.status, s.label))
      .child(div().text_size(TEXT.id).text_color(t.dim).child(when))
      .child(link(`${id}-project`, k.projectLabel(latest.project_id), (_e, cx) => k.go({ page: "project", project: latest.project_id }, cx))),
    link(`${id}-facts-toggle`, open ? "Hide exact execution identity" : "Exact execution identity", (_e, cx) => {
      (k.workerOpen ??= {})[id] = !open;
      cx.notify();
    }),
    ...(open ? [facts(`${id}-facts`, [
      ["Run", shortRun(latest.id)],
      ["Project", latest.project_id],
      ["Phase", latest.phase ?? NOT_RECORDED],
      ["Outcome", latest.outcome ?? NOT_RECORDED],
      ["Sequence", latest.sequence ?? NOT_RECORDED],
      ["Created", formatTime(latest.created_at_ms)],
      ["Started", formatTime(latest.started_at_ms)],
      ["Completed", formatTime(latest.completed_at_ms)],
    ])] : []),
  ]);
}

function heartbeatCard(w, hb, id) {
  const t = theme();
  const obs = w.observed_capacity ?? null;
  const body = [
    h_flex().gap(8).items_center().flex_wrap()
      .child(tag(`${id}-label`, hb.label, { color: tone(hb.status) }))
      .child(div().text_size(TEXT.id).text_color(t.dim).child(`Liveness: ${w.liveness ?? "unknown"}`)),
  ];
  if (obs) {
    body.push(facts(`${id}-observed`, [
      ["Observed slots", obs.observed_slots ?? NOT_RECORDED],
      ["Active slots", obs.active_slots ?? NOT_RECORDED],
      ["Free slots", obs.free_slots ?? NOT_RECORDED],
      ["Last seen", formatTime(obs.last_seen_at_ms)],
    ]));
  } else {
    body.push(words("No observed capacity was recorded for this target. A heartbeat is not a guarantee that an execution ran.", { dim: true }));
  }
  return card(id, "Worker heartbeat", null, body);
}

function projectsCard(k, w, id) {
  const t = theme();
  const list = Array.isArray(w.projects) ? w.projects : [];
  const head = h_flex().gap(6).items_center().min_w(0).pb(2)
    .child(div().flex_1().min_w(0).text_size(TEXT.id).text_color(t.dim).child("Project"))
    .child(div().w(72).flex_none().text_size(TEXT.id).text_color(t.dim).child("Enrollment"))
    .child(div().flex_1().min_w(0).text_size(TEXT.id).text_color(t.dim).child("Occupied slots"))
    .child(div().w(42).flex_none().text_size(TEXT.id).text_color(t.dim).child("Queued"));
  const rows = list.map((p, i) => {
    const rid = `${id}-${i}`;
    const runs = Array.isArray(p.active_run_ids) ? p.active_run_ids : [];
    const slots = runs.length
      ? h_flex().gap(6).flex_wrap().children(runs.map((r, j) =>
        link(`${rid}-run-${j}`, shortRun(r), (_e, cx) => k.go({ page: "runs", run: r, view: "pipeline" }, cx))))
      : div().text_size(TEXT.id).text_color(t.dim).child("No occupied slot");
    return h_flex().id(rid).gap(6).items_center().min_w(0).px(4).py(4).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).child(link(`${rid}-project`, p.label || p.id, (_e, cx) => k.go({ page: "project", project: p.id }, cx))))
      .child(div().w(72).flex_none().text_size(TEXT.id).text_color(p.enrolled ? t.muted : t.dim).child(p.enrolled ? "Enrolled" : "Not enrolled"))
      .child(div().flex_1().min_w(0).child(slots))
      .child(div().w(42).flex_none().text_size(TEXT.id).text_color(t.muted).child(String(p.queued ?? 0)));
  });
  return card(id, "Assigned projects and occupied slots", null,
    list.length ? [head, ...rows] : [words("This target has no assigned project.", { dim: true })]);
}

function bindingCard(w, id) {
  return card(id, "Exact target binding and snapshot", null, facts(id, [
    ["Target ID", div().font_family(MONO).text_size(TEXT.id).child(w.id)],
    ["Provider profile", w.provider_profile_id ?? NOT_RECORDED],
    ["Platform", w.platform ?? NOT_RECORDED],
  ]));
}
