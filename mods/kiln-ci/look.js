// onix: the Kiln panel's parts (mods/kiln): status pills and their colours, chips, facts, cards and the empty and
// failed states, drawn with Shepherdr's sizes (ui.js) and the theme. Kiln's statuses take Shepherdr's own colours:
// passed green, failed red, running and warnings amber, the rest the theme's quiet ones.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme } from "herdr";
import { TEXT, RADIUS, red, green, amber } from "./ui.js";

export const MONO = "JetBrains Mono";
export const icon = (name) => `mods/kiln-ci/${name}.svg`;

export function tone(status, t = theme()) {
  if (status === "success") return green();
  if (status === "failure") return red();
  if (status === "running" || status === "warning") return amber();
  if (status === "cancelled") return t.dim;
  return t.muted;
}

const STATUS_ICON = { success: "circle-check", failure: "circle-x", running: "loader-circle", queued: "clock", cancelled: "ban",
  unknown: "circle-help", warning: "circle-alert", neutral: "circle" };

// A status pill: its icon and word in the status's colour (a dashed edge for unknown, as the website's).
export function pill(id, status, label) {
  const t = theme(), c = tone(status, t);
  return h_flex().id(id).flex_none().h(20).pl(5).pr(7).gap(4).items_center().rounded(10).border(1).border_color(c)
    .when(status === "unknown", (el) => el.border_dashed())
    .text_size(TEXT.id).text_color(c)
    .child(svg(icon(STATUS_ICON[status] ?? "circle")).size(12).flex_none())
    .child(div().whitespace_nowrap().child(label));
}

// A plain tag ("Phase: active", a count): bordered, dim.
export function tag(id, label, { color = null } = {}) {
  const t = theme();
  return div().id(id).flex_none().h(20).px(6).flex().items_center().rounded(RADIUS.control).border(1).border_color(t.border)
    .text_size(TEXT.id).text_color(color ?? t.muted).whitespace_nowrap().child(label);
}

// A choice among a few (filters, nodes, streams): chips that wrap, the chosen one selected.
export function chips(id, options, value, onPick, { disabled = false } = {}) {
  const t = theme();
  return h_flex().id(id).flex_wrap().gap(4).children(options.map(([v, label], i) => {
    const on = v === value;
    return div().id(`${id}-${i}`).flex_none().h(22).px(8).flex().items_center().rounded(RADIUS.control).border(1)
      .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background).text_size(TEXT.label)
      .text_color(on ? t.foreground : t.muted).whitespace_nowrap()
      .when(!disabled && !on, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onPick(v, cx)))
      .when(disabled, (el) => el.opacity(0.5))
      .child(label);
  }));
}

// Label and value rows (a run's facts): the label dim at the left, the value (text or an element) after it. An
// element is aligned to the start, so a pill or a link keeps its own width and long text still wraps in the column.
export function facts(id, rows) {
  const t = theme();
  return v_flex().id(id).gap(4).children(rows.filter(Boolean).map(([label, value], i) =>
    h_flex().id(`${id}-${i}`).gap(8).items_start().min_w(0)
      .child(div().w(116).flex_none().text_size(TEXT.label).text_color(t.dim).child(label))
      .child(typeof value === "string" || typeof value === "number"
        ? div().flex_1().min_w(0).text_size(TEXT.label).text_color(t.foreground).child(String(value))
        : v_flex().flex_1().min_w(0).items_start().child(value))));
}

// A card: an optional header row (title, right side), then its body.
export function card(id, title, right, body) {
  const t = theme();
  return v_flex().id(id).w_full().min_w(0).p(10).gap(8).rounded(RADIUS.card).border(1).border_color(t.border).bg(t.background)
    .when(Boolean(title) || Boolean(right), (el) => el.child(h_flex().gap(8).items_center().min_w(0)
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.body).font_medium().text_color(t.foreground).child(title ?? ""))
      .when(Boolean(right), (r) => r.child(right))))
    .children(Array.isArray(body) ? body.filter(Boolean) : [body]);
}

// Words, dim or not, wrapping.
export const words = (text, { dim = false, size = TEXT.label, color = null } = {}) => {
  const t = theme();
  return div().min_w(0).text_size(size).text_color(color ?? (dim ? t.dim : t.muted)).child(String(text ?? ""));
};

export function emptyState(id, title, text, action = null) {
  const t = theme();
  return v_flex().id(id).w_full().py(18).px(10).gap(4).items_center()
    .child(div().text_size(TEXT.body).font_medium().text_color(t.foreground).child(title))
    .child(div().max_w(420).text_size(TEXT.label).text_color(t.dim).child(text))
    .when(Boolean(action), (el) => el.child(div().pt(6).child(action)));
}

export function errorState(id, text) {
  return h_flex().id(id).w_full().gap(6).items_start().p(8).rounded(RADIUS.control).border(1).border_color(red())
    .child(svg(icon("circle-alert")).size(14).flex_none().text_color(red()))
    .child(div().flex_1().min_w(0).text_size(TEXT.label).text_color(red()).child(text));
}

export function warningLine(id, text) {
  return h_flex().id(id).w_full().gap(6).items_start()
    .child(svg(icon("circle-alert")).size(14).flex_none().text_color(amber()))
    .child(div().flex_1().min_w(0).text_size(TEXT.label).text_color(amber()).child(text));
}

export function loadingLine(id, text = "Loading admitted records…") {
  const t = theme();
  return h_flex().id(id).gap(6).items_center().py(10).text_size(TEXT.label).text_color(t.dim)
    .child(svg(icon("loader-circle")).size(14).flex_none()).child(text);
}

// A whole row that opens something: pointer, the rounded hover, the click.
export function rowLink(id, onClick, el) {
  const t = theme();
  return el.id(id).cursor_pointer().rounded(RADIUS.card).hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx));
}

// A thin bar, `fraction` of its width filled.
export function meter(id, fraction, color) {
  const t = theme();
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return div().id(id).w_full().h(6).rounded(3).bg(t.border)
    .child(div().h_full().w(`${Math.round(f * 1000) / 10}%`).rounded(3).bg(color ?? t.accent));
}
