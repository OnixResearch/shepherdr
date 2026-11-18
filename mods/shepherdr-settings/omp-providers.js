// Agents > omp providers (an OnixResearch fork row): which of omp's providers its model menu offers. omp's catalog
// (`omp models --json`, lib/agent.js ompModels) is filtered to these providers' chat models, so the models a role,
// a task's worker or an agent tab can pick come from here. Everywhere's only, one box (provider names, comma
// between; empty goes back to the default list); the same value the web's Settings page writes and herdr-task's
// settings file holds (~/.config/shepherdr/settings.json, everywhere.onix.omp_providers).
// The row's words and the words' check are core/settings.js (shared with the web app).

import { div } from "gpui-kit";
import { v_flex, InputState, Input } from "gpui-base";
import { OMP_MODELS, ompProvidersOf, ompProvidersFrom } from "./core/settings.js";

// Made in the window's init (an input needs a live host call).
export function ompProvidersInit(view) {
  const f = { box: InputState.new({ placeholder: "" }), shown: undefined, err: "", focus: false, setting: false };
  f.box.on("change", (_e, cx) => { if (!f.setting) { f.err = ""; cx.notify(); } });
  f.box.on("focus", (_e, cx) => { f.focus = true; cx.notify(); });
  f.box.on("blur", (_e, cx) => { f.focus = false; save(view, f, cx); });
  f.box.on("submit", (_e, cx) => save(view, f, cx));
  return f;
}

// The setting as the box says it: the providers its list holds, else the default.
const nowOf = (view) => ompProvidersOf(view.cfg).join(", ");

function save(view, f, cx) {
  const want = ompProvidersFrom(f.box.value());
  if (want === null) { f.err = OMP_MODELS.bad; return cx.notify(); }
  f.err = "";
  const now = nowOf(view);
  // empty: back to the default list, which the box then says (as the row's hint does)
  if (!want.length) {
    if (now === OMP_MODELS.placeholder) return cx.notify();
    f.setting = true;
    f.box.set_value(OMP_MODELS.placeholder);
    f.setting = false;
    f.shown = OMP_MODELS.placeholder;
    return view.reset("onix", "omp_providers", cx);
  }
  const words = want.join(", ");
  if (words === now) return cx.notify();
  f.setting = true;
  f.box.set_value(words);
  f.setting = false;
  f.shown = words;
  view.set("onix", "omp_providers", want, cx);
}

// The box, on Everywhere only; null in a space.
export function ompProvidersRow(view, t) {
  if (view.scope) return null;
  const f = view.op;
  const now = nowOf(view);
  if (f.shown !== now && !f.focus) {
    f.shown = now;
    f.setting = true;
    f.box.set_value(now);
    f.setting = false;
  }
  const box = div().relative().w(220)
    .child(Input.new(f.box).w_full().h(30).px(10).rounded(7).border_1().border_color(f.err ? t.blocked : f.focus ? t.accent : t.input)
      .bg(t.background).text_size(13).text_color(t.foreground))
    .when(!f.box.value(), (el) => el.child(div().absolute().top(6).left(11).right(11).truncate().text_size(13).text_color(t.dim)
      .child(OMP_MODELS.placeholder)));
  const control = v_flex().items_end().gap(5).child(box)
    .when(Boolean(f.err), (el) => el.child(div().w(220).text_size(12).line_height("17px").text_color(t.blocked).child(f.err)));
  return view.row(t, OMP_MODELS.title, OMP_MODELS.about, control, null);
}
