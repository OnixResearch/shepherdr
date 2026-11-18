// Agents > Claude Code / Codex through Underclass (OnixResearch fork rows): whether Shepherdr starts each CLI's agents on
// the Underclass pool's proxy instead of this computer's own sign-in (core/agents.js argvFor, herdr-task's
// underclass.py). Everywhere's only, a switch per CLI: the same value the web's Settings page writes and herdr-task's
// settings file holds (~/.config/shepherdr/settings.json, everywhere.onix.underclass, a list of CLIs).
// The rows' words and the list's rules are core/settings.js (shared with the web app).

import { toggleSwitch } from "./ui.js";
import { UNDERCLASS, underclassList, underclassWith } from "./core/settings.js";

// The switches, on Everywhere only; none in a space.
export function underclassRows(view, t) {
  if (view.scope) return [];
  const on = underclassList(view.cfg);
  return ["claude", "codex"].map((cli) => view.row(t, UNDERCLASS.title[cli], UNDERCLASS.about[cli],
    toggleSwitch(`underclass-${cli}`, on.includes(cli), (next, _e, cx) => {
      const list = underclassWith(on, cli, next);
      return list.length ? view.set("onix", "underclass", list, cx) : view.reset("onix", "underclass", cx);
    }), null));
}
