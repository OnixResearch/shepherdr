// onix: Kiln (the Kiln CI add-on, lib/addons.json "kiln"): Kiln's CI pages as its website has them — Overview, Runs
// (with a run's pipeline, logs, tests, artifacts, comparison, activity and evidence), CI projects (start a run, enroll
// one, a project's history) and Workers — in Shepherdr's side panel, or in a bigger window: its expand button, or
// `mod.open kiln-ci` from any layout (mod.json's overlay). It reads
// and acts through Kiln's own API, as the website does (api.js: over the tailnet to onix.kiln.url, signed in by this
// machine's Tailscale identity), and words what it shows by core/kiln.js, the website's rules. Live: while it is on
// screen it asks /api/live every 1.5 s, as the website, and reloads the open page when Kiln's state moved. A mutation
// is asked first (the website's words), sent once with a fresh request id, and never retried.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { theme, props, layout, openOverlay, closeOverlay } from "herdr";
import { button, segmented, TEXT, RADIUS, red, green } from "./ui.js";
import { loadSettings, request, mutate, live, download } from "./api.js";
import { isRunningRun, CONTROL_NOTE } from "./core/kiln.js";
import { icon, tone, card, facts, errorState, loadingLine } from "./look.js";
import * as overview from "./overview.js";
import * as runs from "./runs.js";
import * as run from "./run.js";
import * as projects from "./projects.js";
import * as workers from "./workers.js";

const PAGES = [["overview", "Overview", "layout-grid"], ["runs", "Runs", "circle-play"], ["projects", "CI projects", "folder"], ["workers", "Workers", "server"]];
const TITLES = { overview: "Overview", runs: "Runs", projects: "CI projects", project: "CI project", workers: "Workers" };
const MODULES = { overview, runs, projects, project: projects, workers };
const LIVE_MS = 1500;
const WIDE = 860;

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
}

export default class Kiln extends View {
  init(_props, cx) {
    this.inWindow = props()?.window === true || Boolean(props()?.overlay);
    this.cfg = null;
    this.session = null;
    this.bootError = null;
    this.route = { page: "overview", ...(props()?.route ?? {}) };
    this.trail = [];
    this.cache = {};
    this.notice = null;
    this.ask = null;
    this.mutating = false;
    this.width = 0;
    this.live = { version: "0", failures: 0, connected: false, running: 0, busy: false, next: 0, stopped: false };
    // Text fields live as long as the view (they can't be made while drawing).
    this.fields = {
      q: InputState.new({ placeholder: "Run, repository, revision…" }),
      source: InputState.new({ placeholder: "Exact source revision" }),
      exact: InputState.new({ placeholder: "Exact reachable revision (40 hex)" }),
      logq: InputState.new({ placeholder: "Search log" }),
      workerq: InputState.new({ placeholder: "Project, provider, platform or target ID" }),
      other: InputState.new({ placeholder: "Other retained run ID" }),
    };
    for (const f of Object.values(this.fields)) f.on("change", (_e, cx) => cx.notify());
    this.fields.q.on("submit", (_e, cx) => this.go({ q: this.fields.q.value().trim(), cursor: "", run: "" }, cx, { replace: true }));
    this.fields.source.on("submit", (_e, cx) => this.go({ source: this.fields.source.value().trim(), cursor: "", run: "" }, cx, { replace: true }));
    this.fields.logq.on("submit", (_e, cx) => run.searchLog(this, cx));
    this.fields.workerq.on("submit", (_e, cx) => cx.notify());
    this.fields.other.on("submit", (_e, cx) => this.go({ other: this.fields.other.value().trim(), view: "compare" }, cx, { replace: true }));
    cx.spawn(async (cx) => this.boot(cx));
    cx.timer.every(500, (cx) => this.tick(cx));
    // Elapsed clocks and "2m ago" move on; the open run follows its log (run.tick).
    cx.timer.every(1000, (cx) => {
      if (!this.shown()) return;
      if (this.route.run && this.session) run.tick(this, cx);
      if (this.live.running > 0 || this.route.run) cx.notify();
    });
    cx.timer.every(30000, (cx) => { if (this.shown()) cx.notify(); });
  }

  // ---- data -------------------------------------------------------------------------------------

  async boot(cx) {
    this.bootError = null;
    this.cfg = await loadSettings();
    if (!this.cfg.url) { cx.notify(); return; }
    try {
      this.session = await request(this.cfg, "/api/session");
      if (this.session?.permissions?.read !== true) throw new Error("Kiln gave this machine no read access.");
    } catch (e) {
      this.session = null;
      this.bootError = e?.status === 401 || e?.status === 403
        ? `Kiln didn't admit this machine's tailnet identity (${e.message}).`
        : e?.message ?? String(e);
      cx.notify();
      return;
    }
    await Promise.all([this.fetch("projects", "/api/projects"), this.load(cx)]);
    this.live = { ...this.live, version: "0", failures: 0, stopped: false, next: 0 };
    cx.notify();
  }

  // GET into the cache under `key`: { data, error, at }. A quiet read keeps the old data on screen while it runs.
  async fetch(key, path) {
    const c = (this.cache[key] ??= { data: null, error: null, at: 0, loading: false });
    c.loading = true;
    try {
      c.data = await request(this.cfg, path);
      c.error = null;
      c.at = Date.now();
    } catch (e) {
      c.error = e?.message ?? String(e);
    } finally {
      c.loading = false;
    }
    return c;
  }
  get(path) { return request(this.cfg, path); }
  data(key) { return this.cache[key]?.data ?? null; }
  failure(key) { return this.cache[key]?.error ?? null; }
  waiting(key) { const c = this.cache[key]; return !c || (c.loading && !c.data && !c.error); }
  projectLabel(id) { return this.data("projects")?.enrolled?.find((p) => p.id === id)?.label || this.data("projects")?.available?.find((p) => p.id === id)?.label || id; }
  canOperate() { return this.session?.permissions?.operate === true; }
  stale() { return !this.live.connected && this.live.failures > 0; }

  async load(cx, opts = {}) {
    const mod = MODULES[this.route.page] ?? overview;
    const jobs = [mod.load(this, cx, opts)];
    if (this.route.run && (this.route.page === "runs")) jobs.push(run.load(this, cx, opts));
    await Promise.all(jobs);
    cx.notify();
  }

  // Kiln's live snapshot: count what runs, keep the open run current (never older), reload the page when Kiln moved.
  tick(cx) {
    const L = this.live;
    if (!this.cfg?.url || !this.session || L.busy || L.stopped || Date.now() < L.next || !this.shown()) return;
    L.busy = true;
    cx.spawn(async (cx) => {
      try {
        const snap = await live(this.cfg, L.version);
        L.failures = 0;
        L.connected = true;
        if (snap) {
          if (Number(snap.version) < Number(L.version)) throw new Error("The live version moved backwards.");
          const changed = String(snap.version) !== L.version;
          L.version = String(snap.version);
          L.running = snap.runs.filter(isRunningRun).length;
          run.adopt(this, snap.runs);
          if (changed) await this.load(cx, { quiet: true });
        }
        L.next = Date.now() + LIVE_MS;
      } catch (e) {
        L.failures++;
        L.connected = false;
        L.reason = e?.message ?? String(e);
        L.next = Date.now() + Math.min(15000, 1500 * 2 ** (L.failures - 1));
        if (L.failures >= 6) L.stopped = true;
      } finally {
        L.busy = false;
        cx.notify();
      }
    });
  }

  refresh(cx) {
    this.notice = null;
    this.live = { ...this.live, version: "0", failures: 0, stopped: false, next: 0 };
    cx.spawn(async (cx) => {
      if (!this.session) return this.boot(cx);
      await Promise.all([this.fetch("projects", "/api/projects"), this.load(cx)]);
      cx.notify();
    });
    cx.notify();
  }

  // On screen: the bigger window always; the side panel while it is open on Kiln.
  shown() {
    if (this.inWindow) return true;
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    return Boolean(panel && !panel.hidden && body?.active === "kiln");
  }

  // ---- where it is ----------------------------------------------------------------------------------

  // Goes to a page or a run (patch over the route; a new page starts clean), keeping where it was for Back.
  go(patch, cx, { replace = false } = {}) {
    const fresh = patch.page && patch.page !== this.route.page;
    if (!replace) this.trail.push(this.route);
    if (this.trail.length > 40) this.trail.shift();
    this.route = Object.fromEntries(Object.entries({ ...(fresh ? {} : this.route), ...patch }).filter(([, v]) => v !== "" && v !== null && v !== undefined));
    this.route.page ??= "overview";
    this.ask = null;
    if (fresh || patch.run !== undefined) run.reset(this);
    cx.spawn(async (cx) => this.load(cx));
    cx.notify();
  }
  back(cx) {
    const prev = this.trail.pop();
    if (!prev) return;
    this.route = prev;
    this.ask = null;
    run.reset(this);
    cx.spawn(async (cx) => this.load(cx));
    cx.notify();
  }
  drilled() { return Boolean(this.route.run || this.route.page === "project" || this.route.worker); }

  openWindow() {
    openOverlay({ mod: "kiln-ci", kind: "dialog", width: 0.94, height: 0.92, props: { window: true, route: this.route } });
  }

  // ---- acting ------------------------------------------------------------------------------------------

  // Asks before a mutation, inline (the website's dialog words): { title, verb, cancel, danger, facts, act: async () => text }.
  confirm(ask, cx) { this.ask = ask; cx.notify(); }

  // One mutation at a time, sent once: the notice says what came back, and the request's id.
  send(path, payload, { done, then } = {}, cx) {
    if (this.mutating) return;
    this.mutating = true;
    this.ask = null;
    cx.spawn(async (cx) => {
      try {
        const { data, id } = await mutate(this.cfg, path, payload);
        this.notice = { kind: "success", text: `${done ?? "Request admitted."} Request ${id}.` };
        if (then) await then(data, cx);
      } catch (e) {
        this.notice = { kind: "error", text: `${e?.message ?? e} Request ${e?.requestId ?? "unknown"}. This mutation was not retried. Refresh admitted state before deciding whether to issue a new request; a timeout or connection failure may still have applied.` };
      } finally {
        this.mutating = false;
        await this.load(cx, { quiet: true });
        cx.notify();
      }
    });
    cx.notify();
  }

  save(path, name, cx) {
    cx.spawn(async (cx) => {
      try {
        const file = await download(this.cfg, path, name);
        this.notice = { kind: "success", text: `Saved ${file}.` };
      } catch (e) {
        this.notice = { kind: "error", text: `Download failed: ${e?.message ?? e}` };
      }
      cx.notify();
    });
  }

  say(text, kind = "info") { this.notice = text ? { kind, text } : null; }

  // ---- drawing ------------------------------------------------------------------------------------------

  render(cx) {
    const t = theme();
    const wide = this.width >= WIDE;
    return v_flex().id("kiln").size_full().min_h(0).min_w(0).bg(t.background).text_color(t.foreground)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .child(this.header(t, cx))
      .child(this.body(t, wide, cx))
      .when(Boolean(this.notice), (el) => el.child(this.noticeBar(t)));
  }

  header(t, cx) {
    const L = this.live;
    const r = this.route;
    const title = r.run ? run.title(this) : r.page === "project" ? this.projectLabel(r.project) : r.worker ? workers.title(this) : TITLES[r.page] ?? "Kiln";
    const status = !this.session ? null
      : L.stopped ? ["Disconnected · reconnect required", red()]
      : L.connected ? ["Live", green()]
      : L.failures ? [`Stale · reconnect ${L.failures}/6`, tone("warning")]
      : ["Connecting live observations…", t.dim];
    const iconButton = (id, name, onClick) => div().id(id).flex_none().size(24).flex().items_center().justify_center().rounded(RADIUS.control)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClick(cx))
      .child(svg(icon(name)).size(14));
    return h_flex().id("kiln-head").flex_none().h(42).px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .when(this.drilled() && this.trail.length > 0, (el) => el.child(iconButton("kiln-back", "chevron-left", (cx) => this.back(cx))))
      .child(svg(icon("kiln")).size(16).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.body).font_semibold().child(title))
      .when(this.live.running > 0 && Boolean(this.session), (el) => el.child(
        div().id("kiln-running").flex_none().text_size(TEXT.id).text_color(tone("running")).cursor_pointer()
          .on_click((_e, cx) => this.go({ page: "runs", outcome: "pending" }, cx))
          .child(`${this.live.running} running`)))
      .when(Boolean(status), (el) => el.child(h_flex().flex_none().gap(4).items_center()
        .child(div().size(7).rounded(4).bg(status[1]))
        .child(div().text_size(TEXT.id).text_color(t.dim).whitespace_nowrap().child(status[0]))))
      .child(iconButton("kiln-refresh", "rotate-cw", (cx) => this.refresh(cx)))
      .child(this.inWindow
        ? iconButton("kiln-close", "x", () => closeOverlay(props().overlay))
        : iconButton("kiln-window", "maximize-2", () => this.openWindow()));
  }

  nav(t, wide, cx) {
    const page = this.route.page === "project" ? "projects" : this.route.page;
    if (!wide) {
      return h_flex().id("kiln-nav").flex_none().px(10).py(8).border_b(1).border_color(t.border)
        .child(segmented("kiln-pages", PAGES.map(([id, label]) => [id, label]), page, (v, _e, cx) => this.go({ page: v }, cx), { fill: true }));
    }
    return v_flex().id("kiln-rail").flex_none().w(190).h_full().p(8).gap(2).border_r(1).border_color(t.border)
      .child(div().px(8).pt(4).pb(6).text_size(TEXT.label).text_color(t.dim).child("Continuous integration"))
      .children(PAGES.map(([id, label, ic]) => {
        const on = page === id;
        return h_flex().id(`kiln-rail-${id}`).h(30).px(8).gap(8).items_center().rounded(RADIUS.control)
          .bg(on ? t.selected : t.background).text_size(TEXT.body).text_color(on ? t.foreground : t.muted)
          .when(!on, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .on_click((_e, cx) => this.go({ page: id }, cx))
          .child(svg(icon(ic)).size(15).flex_none()).child(label);
      }));
  }

  body(t, wide, cx) {
    if (!this.cfg) return v_flex().flex_1().p(12).child(loadingLine("kiln-boot", "Reading Kiln's settings…"));
    if (!this.cfg.url) return v_flex().flex_1().p(12).child(this.setup(t));
    if (!this.session) {
      return v_flex().id("kiln-signin").flex_1().p(12).gap(10)
        .child(this.bootError ? errorState("kiln-boot-error", this.bootError) : loadingLine("kiln-boot", "Asking Kiln who this is…"))
        .when(Boolean(this.bootError), (el) => el.child(h_flex().child(button("kiln-retry", "Try again", { onClick: (_e, cx) => { this.bootError = null; cx.spawn(async (cx) => this.boot(cx)); cx.notify(); } }))));
    }
    const content = this.page(t, wide, cx);
    // h_flex centres its children across: the page column takes the row's full height itself, or its scroll area
    // would collapse to nothing.
    const main = v_flex().id("kiln-main").flex_1().min_w(0).min_h(0).when(wide, (el) => el.h_full())
      .when(!wide, (el) => el.child(this.nav(t, wide, cx)))
      .when(Boolean(this.ask), (el) => el.child(this.askCard(t, cx)))
      .child(content);
    return wide
      ? h_flex().id("kiln-body").flex_1().min_h(0).child(this.nav(t, wide, cx)).child(main)
      : v_flex().id("kiln-body").flex_1().min_h(0).child(main);
  }

  // The open page: a run on its own (narrow) or beside the run list (wide); else the page's own content.
  page(t, wide, cx) {
    const r = this.route;
    const scroll = (id, child) => v_flex().id(id).flex_1().min_h(0).min_w(0).overflow_y_scrollbar().p(10).gap(10).child(child);
    if (r.page === "runs" && r.run) {
      if (!wide) return scroll("kiln-run-scroll", run.render(this, cx));
      return h_flex().id("kiln-split").flex_1().min_h(0)
        .child(v_flex().id("kiln-list-col").w(400).flex_none().h_full().min_h(0).border_r(1).border_color(t.border)
          .child(scroll("kiln-list-scroll", runs.render(this, cx, { compact: true }))))
        .child(scroll("kiln-run-scroll", run.render(this, cx)).h_full());
    }
    const mod = MODULES[r.page] ?? overview;
    return scroll(`kiln-${r.page}-scroll`, mod.render(this, cx, { wide }));
  }

  setup(t) {
    return card("kiln-setup", "Kiln isn't set up here", null, [
      div().text_size(TEXT.label).text_color(t.muted).child("Shepherdr shows Kiln's CI as its website does once it knows where that website is. In ~/.config/shepherdr/settings.json, under everywhere.onix.kiln (or this machine's), set url to Kiln's website (https://host:port) and, when Kiln's certificate is its own, ca to a copy of Kiln's CA certificate on this computer."),
      div().p(8).rounded(RADIUS.control).bg(t.raised ?? t.hover).font_family("JetBrains Mono").text_size(TEXT.id).text_color(t.foreground)
        .child('"onix": { "kiln": { "url": "https://<kiln host>:9443", "ca": "~/.config/shepherdr/kiln-ca.pem" } }'),
      div().text_size(TEXT.label).text_color(t.dim).child("Kiln's proxy signs this machine in by its Tailscale identity, as it does a browser on the tailnet."),
    ]);
  }

  askCard(t, cx) {
    const a = this.ask;
    return v_flex().id("kiln-ask").flex_none().m(10).mb(0).p(12).gap(8).rounded(RADIUS.card).border(1).border_color(a.danger ? red() : t.accent).bg(t.background)
      .child(div().text_size(TEXT.body).font_semibold().child(a.title))
      .child(div().text_size(TEXT.label).text_color(t.muted).child(CONTROL_NOTE))
      .when(Array.isArray(a.facts) && a.facts.length > 0, (el) => el.child(facts("kiln-ask-facts", a.facts)))
      .child(h_flex().gap(8).justify_end()
        .child(button("kiln-ask-no", a.cancel ?? "Cancel", { kind: "plain", onClick: (_e, cx) => { this.ask = null; cx.notify(); } }))
        .child(button("kiln-ask-yes", a.verb, { kind: a.danger ? "secondary" : "primary", disabled: this.mutating, onClick: (_e, cx) => a.act(cx) })));
  }

  noticeBar(t) {
    const n = this.notice;
    const c = n.kind === "error" ? red() : n.kind === "success" ? green() : t.muted;
    return h_flex().id("kiln-notice").flex_none().px(10).py(6).gap(8).items_start().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).text_size(TEXT.label).text_color(c).child(n.text))
      .child(div().id("kiln-notice-x").flex_none().cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.notice = null; cx.notify(); }).child(svg(icon("x")).size(12)));
  }
}
