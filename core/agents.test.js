import { expect, test } from "bun:test";
import { argvFor, current, forkArgv, FORK_LIVE, freshArgv, kindOfArgv, line, liveTaskAgent, menuFor, modelSections, ompModelOK, ompProviders, ompSessionId, parseDefaults, parseOmpModels, parsePicks, pickKey, resumeArgv, rowFor, sessionOf, withPin, withRecent, speedFor, speedOf, codexTier, speedName, speedWordOf, OMP_PROVIDERS } from "./agents.js";

const SESS = "/tmp/.omp/agent/sessions/-git-onix/2026-11-18T10-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl";
const codex = { models: Array.from({ length: 250 }, (_, i) => ({ id: `gpt-${i}`, label: `GPT ${i}`, efforts: ["low", "high"] })) };
const menus = { claude: menuFor("claude", {}), codex: menuFor("codex", codex) };

test("Codex lists every model it has, not its first five", () => {
  expect(menus.codex.models.length).toBe(250);
});

test("nothing typed: pinned, then recent, then the rest of the agent shown", () => {
  const picks = withRecent(withPin(parsePicks(""), pickKey("claude", "haiku")), pickKey("claude", "sonnet"));
  const s = modelSections(menus, "claude", picks, "");
  expect(s.map((x) => x.title)).toEqual(["Pinned", "Recent", "All models"]);
  expect(s[0].rows.map((r) => r.id)).toEqual(["haiku"]);
  expect(s[1].rows.map((r) => r.id)).toEqual(["sonnet"]);
  expect(s[2].rows.some((r) => r.id === "haiku" || r.id === "sonnet")).toBe(false);
});

test("a long list is capped and counts the rest", () => {
  const [all] = modelSections(menus, "codex", null, "");
  expect(all.rows.length).toBe(200);
  expect(all.more).toBe(50);
});

test("typed: every agent's matches, and a row to use the id typed", () => {
  const s = modelSections(menus, "codex", null, "opus 1m");
  expect(s.map((x) => x.key)).toEqual(["claude"]);
  expect(s[0].rows.map((r) => r.id)).toEqual(["opus[1m]"]);
  const t = modelSections(menus, "codex", null, "gpt-7-preview").find((x) => x.key === "typed");
  expect(t.rows.map((r) => [r.agent, r.id, r.typed])).toEqual([["codex", "gpt-7-preview", true], ["claude", "gpt-7-preview", true]]);
  expect(modelSections(menus, "codex", null, "gpt-999").map((x) => x.key)).toEqual(["typed"]);
  expect(modelSections(menus, "codex", null, "gpt-12").find((x) => x.key === "typed").rows.map((r) => r.agent)).toEqual(["claude"]);
});

test("an exact id typed needs no extra row; picks survive bad files", () => {
  expect(parsePicks("not json")).toEqual({ pinned: [], recent: [] });
  expect(withPin(withPin(parsePicks(""), "a:b"), "a:b").pinned).toEqual([]);
});

test("a running model typed by id stays in its agent's list", () => {
  expect(menuFor("claude", {}, "claude-opus-4-8").models[0]).toMatchObject({ id: "claude-opus-4-8", name: "Opus 4.8" });
});

test("a pinned or recent model typed by id stays on offer", () => {
  const picks = withRecent(withPin(parsePicks(""), "claude:claude-opus-4-8"), "codex:gpt-x");
  expect(modelSections(menus, "claude", picks, "")[0].rows[0]).toMatchObject({ id: "claude-opus-4-8", name: "Opus 4.8", pinned: true });
  expect(modelSections(menus, "codex", picks, "")[0]).toMatchObject({ title: "Recent", rows: [{ id: "gpt-x" }] });
  expect(modelSections(menus, "claude", picks, "gpt-x").map((x) => x.key)).toEqual(["codex", "typed"]);
});

// SHEP-41: Fast was hidden (and stuck on) for a Codex whose config.toml set service_tier.
test("every agent with a fast mode shows the Fast switch, and turning it off sticks", () => {
  const cache = JSON.stringify({ models: [{ slug: "gpt-x", display_name: "GPT-X", supported_reasoning_levels: [{ effort: "high" }], service_tiers: [{ id: "priority" }] },
    { slug: "gpt-slow", display_name: "GPT-Slow", service_tiers: [] }] });
  const dflt = parseDefaults("codex", `model\tgpt-x\nservice_tier\tfast\nmodels\t${cache}\n`);
  const codexMenu = menuFor("codex", dflt);
  expect(codexMenu.models.find((m) => m.id === "gpt-x").fast).toBe(true);
  expect(codexMenu.models.find((m) => m.id === "gpt-slow").fast).toBe(false);
  expect(codexMenu.fastLocked).toBeUndefined();
  expect(menuFor("claude", {}).models.find((m) => m.id === "opus").fast).toBe(true);
  // off: said on the command line, so config.toml's fast loses, and the label reads it back
  const off = argvFor({ agent: "codex", model: "gpt-x", effort: "high", fast: false }, { agent: "codex", argv: ["codex", "-c", 'service_tier="fast"'] }).argv;
  expect(off.filter((a) => a.startsWith("service_tier"))).toEqual(['service_tier="default"']);
  expect(current("codex", off, {}, dflt).fast).toBe(false);
  expect(line(current("codex", off, {}, dflt))).toBe("Codex · GPT-X · High");
  const on = argvFor({ agent: "codex", model: "gpt-x", fast: true }, { agent: "codex", argv: off }).argv;
  expect(current("codex", on, {}, dflt).fast).toBe(true);
  const claudeOff = argvFor({ agent: "claude", model: "opus", fast: false }, { agent: "claude", argv: ["claude"] }).argv;
  expect(current("claude", claudeOff, {}, { fast: true }).fast).toBe(false);
});

// A terminal's own argv as herdr-task runs a worker: nice, sh -c, env and the person's `bash -ic` before the agent.
const wrapped = (...agent) => ["sh", "-c", "exec nice -n 10 \"$@\"", "herdr-low", "sh", "-c", "for v in ...; exec \"$@\"", "herdr-clean",
  "env", "HERDR_BROWSER_TASK=demo#1", "/bin/bash", "-ic", "\"$@\"; exec \"$0\" -i", "/bin/bash", ...agent];

test("#1001: a restart keeps only the agent's own flags, never its launcher's (bash -ic was Codex's -i c, an image)", () => {
  const old = { agent: "codex", argv: wrapped("codex", "-c", "hooks.state={}", "--no-daemon", "-m", "gpt-6-sol", "Do the task"), session: "S1" };
  const { argv, base } = argvFor({ agent: "codex", model: "gpt-6-sol", perm: "auto" }, old);
  expect(argv.some((a) => /^-i/.test(a))).toBe(false);
  expect(argv).not.toContain("herdr-clean");
  expect(argv.filter((a, i) => argv[i - 1] === "-c")).toEqual(["hooks.state={}", 'service_tier="default"']);
  expect(base[0]).toBe("codex");
  expect(argv.slice(0, 2)).toEqual(["codex", "resume"]);
  const c = argvFor({ agent: "claude", model: "opus" }, { agent: "claude", argv: wrapped("claude", "--add-dir", "/x", "hi"), session: "S2" }).argv;
  expect(c).toEqual(["claude", "--add-dir", "/x", "--model", "opus", "--settings", '{"fastMode":false}', "--resume", "S2"]);
  expect(forkArgv("codex", wrapped("codex", "-m", "gpt-6-sol"), "S3")).toEqual(["codex", "fork", "-m", "gpt-6-sol", "--no-daemon", "S3"]);
});

test("#973: Fable 5.2 is in Claude's model menu, the fable alias its row", () => {
  const ids = menuFor("claude", {}).models.map((m) => m.id);
  expect(ids).toContain("claude-fable-5-2");
  expect(menuFor("claude", {}).models.find((m) => m.id === "claude-fable-5-2").name).toBe("Fable 5.2");
  expect(rowFor("claude", { alias: "fable", model: "claude-fable-5-2" })).toBe("claude-fable-5-2");
});

test("#1050: forking a task's chat while its agent runs asks first; a plain chat or an ended task doesn't", () => {
  const agent = (address, labels, extra = {}) => ({ address, state: "live", labels, status: { app: "claude-code" }, ...extra });
  const worker = agent("t1", { "herdr.task": "repo#7" });
  const all = [worker, agent("t2", { "herdr.task": "repo#7", "herdr.role": "reviewer" }), agent("t3", { "herdr.task": "repo#8" })];
  expect(liveTaskAgent(worker, all)?.address).toBe("t1");
  // an older session of the task, its agent now t1
  expect(liveTaskAgent({ address: "t0", state: "finished", labels: { "herdr.task": "repo#7" } }, all)?.address).toBe("t1");
  expect(liveTaskAgent(agent("t4", {}), all)).toBe(null);
  // the agent quit, its shell stays
  expect(liveTaskAgent(worker, [{ ...worker, status: { app: null }, foreground: { name: "bash" } }])).toBe(null);
  // only the reviewer left
  expect(liveTaskAgent(worker, [all[1]])).toBe(null);
  expect(FORK_LIVE.verb).toBe("Fork anyway");
});

// Restart Assistant after an /exit (GitHub #1039): the same conversation, with the flags it ran with.
test("an ended Claude Assistant resumes its own session with its own flags", () => {
  const argv = ["claude", "--model", "opus", "--effort", "high", "--dangerously-skip-permissions"];
  expect(resumeArgv("claude", argv, "11111111-2222-3333-4444-555555555555"))
    .toEqual(["claude", "--model", "opus", "--effort", "high", "--dangerously-skip-permissions", "--resume", "11111111-2222-3333-4444-555555555555"]);
});

test("an ended Codex Assistant resumes with codex resume <session>", () => {
  const out = resumeArgv("codex", ["codex", "--no-daemon", "-m", "gpt-5"], "abc");
  expect(out[0]).toBe("codex");
  expect(out[1]).toBe("resume");
  expect(out.at(-1)).toBe("abc");
  expect(out).toContain("--no-daemon");
  expect(out).not.toContain("fork");
});

test("an Assistant that was itself resumed resumes the session it ran last, once", () => {
  expect(resumeArgv("claude", ["claude", "--resume", "old-id", "--model", "opus"], "new-id")).toEqual(["claude", "--model", "opus", "--resume", "new-id"]);
});

// SHEP-258: Codex's Ultrafast tier (service_tier="ultrafast"), beside Fast, on the models whose catalog offers it.
test("Ultrafast shows where Codex's catalog offers it, and starts Codex on that tier", () => {
  const cache = JSON.stringify({ models: [
    { slug: "gpt-6.2-sol", display_name: "GPT-6.2-Sol", default_reasoning_level: "low", supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
      service_tiers: [{ id: "priority", name: "Fast" }, { id: "ultrafast", name: "Ultrafast" }] },
    { slug: "gpt-6.2-astra", display_name: "GPT-6.2-Astra", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }], service_tiers: [{ id: "priority", name: "Fast" }] }] });
  const dflt = parseDefaults("codex", `model\tgpt-6.2-sol\nservice_tier\tultrafast\nmodels\t${cache}\n`);
  expect(dflt.fast).toBe("ultrafast");
  const menu = menuFor("codex", dflt);
  expect(menu.models.map((m) => [m.id, m.name, m.fast, !!m.ultrafast])).toEqual([["gpt-6.2-sol", "GPT-6.2-Sol", true, true], ["gpt-6.2-astra", "GPT-6.2-Astra", true, false]]);
  expect(menu.models[0].efforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  // started on it: said on the command line, read back, and in words
  const { argv } = argvFor({ agent: "codex", model: "gpt-6.2-sol", effort: "high", fast: "ultrafast" }, { agent: "codex", argv: ["codex", "-c", 'service_tier="fast"'] });
  expect(argv).toEqual(["codex", "--no-daemon", "-m", "gpt-6.2-sol", "-c", 'model_reasoning_effort="high"', "-c", 'service_tier="ultrafast"']);
  expect(current("codex", argv, {}, dflt).fast).toBe("ultrafast");
  expect(line(current("codex", argv, {}, dflt))).toBe("Codex · GPT-6.2-Sol · High · Ultrafast");
  // the log's word wins, and Fast stays Fast
  expect(current("codex", argv, { speed: "fast" }, dflt).fast).toBe(true);
  expect(current("codex", ["codex"], { speed: "ultrafast" }, {}).fast).toBe("ultrafast");
  // a fork keeps it
  expect(forkArgv("codex", argv, "S")).toContain('service_tier="ultrafast"');
  // Claude Code has no Ultrafast: it reads as Fast
  expect(argvFor({ agent: "claude", model: "opus", fast: "ultrafast" }, { agent: "claude", argv: ["claude"] }).argv).toContain('{"fastMode":true}');
});

test("a model without Ultrafast falls back to Fast, one without Fast to standard", () => {
  expect(speedFor({ fast: true, ultrafast: true }, "ultrafast")).toBe("ultrafast");
  expect(speedFor({ fast: true }, "ultrafast")).toBe(true);
  expect(speedFor({ fast: false }, "ultrafast")).toBe(false);
  expect(speedFor({ fast: true }, true)).toBe(true);
  expect(speedFor({}, true)).toBe(false);
  expect([speedOf("priority"), speedOf("ultrafast"), speedOf("default"), speedOf("standard")]).toEqual([true, "ultrafast", false, false]);
  expect([codexTier("ultrafast"), codexTier(true), codexTier(false)]).toEqual(["ultrafast", "fast", "default"]);
  expect([speedName("ultrafast"), speedName(true), speedName(false)]).toEqual(["Ultrafast", "Fast", null]);
  expect([speedWordOf("ultrafast"), speedWordOf(true), speedWordOf(false)]).toEqual(["ultrafast", "fast", "normal"]);
});

// ---- omp: its own catalog, its argv, its session file (an OnixResearch fork's agent kind) ---------------------------

// `omp models --json`, as omp 18.22 answers it: its chat models of its providers, an embedding row, and a row without an id
const OMP_CATALOG = JSON.stringify({ models: [
  { provider: "underclass", kind: "chat", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", thinking: ["low", "high"], contextWindow: 200000 },
  { provider: "mesh", kind: "chat", id: "gpt-5.4", name: "GPT-5.4", thinking: ["low", "medium"], contextWindow: 1000000 },
  { provider: "anthropic", kind: "chat", id: "claude-opus-5-5", name: "Opus 5.5" },
  { provider: "underclass", kind: "embedding", id: "embed-1", name: "Embed" },
  { provider: "mesh", kind: "chat", name: "no id at all" },
] });

test("omp's catalog is its chat models of the providers the setting allows, each id provider/id", () => {
  const models = parseOmpModels(OMP_CATALOG);
  expect(models.map((m) => m.id)).toEqual(["underclass/deepseek-v4.1-flash", "mesh/gpt-5.4"]);
  expect(models[0]).toMatchObject({ label: "DeepSeek V4.1 Flash", efforts: ["low", "high"], contextWindow: 200000 });
  // one provider picked: only its models; a provider it doesn't have: none
  expect(parseOmpModels(OMP_CATALOG, ["mesh"]).map((m) => m.id)).toEqual(["mesh/gpt-5.4"]);
  expect(parseOmpModels(OMP_CATALOG, "underclass, nope").map((m) => m.id)).toEqual(["underclass/deepseek-v4.1-flash"]);
  expect(parseOmpModels("not json")).toEqual([]);
  // the setting as it is kept: an array or one comma-separated line; nothing usable: the default
  expect(ompProviders("mesh, underclass")).toEqual(["mesh", "underclass"]);
  expect(ompProviders(["Mesh"])).toEqual(["mesh"]);
  expect([ompProviders([]), ompProviders(""), ompProviders(null)]).toEqual([OMP_PROVIDERS, OMP_PROVIDERS, OMP_PROVIDERS]);
});

test("omp's menu offers its catalog's models, their own thinking levels and its approval modes", () => {
  const menu = menuFor("omp", { models: parseOmpModels(OMP_CATALOG) });
  expect(menu.name).toBe("omp");
  expect(menu.models.map((m) => m.id)).toEqual(["underclass/deepseek-v4.1-flash", "mesh/gpt-5.4"]);
  expect(menu.models[0].efforts).toEqual(["low", "high"]);
  expect(menu.perms.map((p) => [p.id, p.label])).toEqual([["manual", "Ask"], ["auto", "Write"], ["bypassPermissions", "Full access"]]);
  // the model it runs (a typed id) stays on offer, with omp's own levels
  expect(menuFor("omp", { models: [] }, "underclass/typed-id").models[0])
    .toMatchObject({ id: "underclass/typed-id", efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] });
});

test("omp starts as omp itself: --model provider/id, --thinking, --approval-mode", () => {
  const pick = { agent: "omp", model: "underclass/deepseek-v4.1-flash", effort: "high", perm: "auto" };
  const built = argvFor(pick, { agent: null, argv: [] });
  expect(built.argv).toEqual(["omp", "--model", "underclass/deepseek-v4.1-flash", "--thinking", "high", "--approval-mode", "write"]);
  expect([built.resume, built.base]).toEqual([false, built.argv]);
  // Shepherdr's words as its own modes: ask is always-ask-cached, full access is yolo
  expect(argvFor({ ...pick, perm: "manual" }, { agent: null, argv: [] }).argv.slice(-2)).toEqual(["--approval-mode", "always-ask-cached"]);
  expect(argvFor({ ...pick, perm: "bypassPermissions" }, { agent: null, argv: [] }).argv.slice(-2)).toEqual(["--approval-mode", "yolo"]);
  // nothing said: no flag (omp's own defaults stand)
  expect(argvFor({ agent: "omp", model: "mesh/gpt-5.4" }, { agent: null, argv: [] }).argv).toEqual(["omp", "--model", "mesh/gpt-5.4"]);
  // a ":" in a model id is a thinking level to omp: refused, but a pinned openrouter ":free" id is its own
  expect(() => argvFor({ agent: "omp", model: "openrouter/llama:high" }, { agent: null, argv: [] })).toThrow(/thinking level/);
  expect([ompModelOK("openrouter/llama:free"), ompModelOK("mesh/gpt-5.4")]).toEqual([true, true]);
  expect(argvFor({ agent: "omp", model: "openrouter/llama:free" }, { agent: null, argv: [] }).argv).toContain("openrouter/llama:free");
});

test("switching to omp from another CLI keeps none of that CLI's flags, and omp's own flags survive a restart", () => {
  // a launcher's words before the agent (nice, sh -c, the person's bash -ic) are never omp's flags
  const old = { agent: "claude", argv: ["sh", "-c", "exec nice -n 10 \"$@\"", "herdr-low", "claude", "--add-dir", "/x", "--model", "opus"] };
  expect(argvFor({ agent: "omp", model: "mesh/gpt-5.4", perm: "manual" }, old).argv)
    .toEqual(["omp", "--model", "mesh/gpt-5.4", "--approval-mode", "always-ask-cached"]);
  // omp's own flags kept: its provider, folders and level defaults
  const argv = ["omp", "--profile", "work", "--add-dir", "/repo", "--model", "mesh/gpt-5.4", "--thinking", "low", "--approval-mode", "write", "do the thing"];
  const built = argvFor({ agent: "omp", model: "mesh/gpt-5.4", effort: "high", perm: "manual" }, { agent: "omp", argv, session: SESS });
  expect(built.argv).toEqual(["omp", "--profile", "work", "--add-dir", "/repo", "--model", "mesh/gpt-5.4", "--thinking", "high", "--approval-mode", "always-ask-cached", "--resume", SESS]);
  expect(built.resume).toBe(true);
});

test("omp resumes its session file's path; it has no fork (the fork starts a new conversation with a handoff)", () => {
  expect(sessionOf("omp", SESS)).toBe(SESS);
  expect(ompSessionId(SESS)).toBe("11111111-2222-3333-4444-555555555555");
  expect(sessionOf("omp", "/x/some-log.txt")).toBe(null);
  const argv = ["omp", "--model", "mesh/gpt-5.4", "--thinking", "low", "--approval-mode", "write", "--resume", SESS];
  expect(resumeArgv("omp", argv, SESS))
    .toEqual(["omp", "--model", "mesh/gpt-5.4", "--thinking", "low", "--approval-mode", "write", "--resume", SESS]);
  // the same, once that session is gone: its model, thinking and approvals, no resume
  expect(freshArgv("omp", argv)).toEqual(["omp", "--model", "mesh/gpt-5.4", "--thinking", "low", "--approval-mode", "write"]);
  expect(freshArgv("omp", ["omp", "--model", "mesh/gpt-5.4"])).toBe(null);
  expect(forkArgv("omp", argv, SESS)).toBe(null);
  // its word in a launcher's line is the agent's
  expect(kindOfArgv(["sh", "-c", "exec \"$@\"", "herdr-clean", "omp", "--model", "mesh/gpt-5.4"])).toBe("omp");
  expect(kindOfArgv(["bash", "-ic", "claude go"])).toBe(null);
});

test("what a running omp runs on: its argv and its log, with its catalog's label and context window", () => {
  const dflt = { models: parseOmpModels(OMP_CATALOG) };
  const c = current("omp", ["omp", "--model", "mesh/gpt-5.4", "--thinking", "medium", "--approval-mode", "yolo"], {}, dflt);
  expect(c).toMatchObject({ agent: "omp", model: "mesh/gpt-5.4", label: "GPT-5.4", effort: "medium", perm: "bypassPermissions", fast: false, window: 1000000 });
  expect(line(c)).toBe("omp · GPT-5.4 · Medium");
  expect(rowFor("omp", c)).toBe("mesh/gpt-5.4");
  // its log names the provider apart from the model (its own message records)
  expect(current("omp", ["omp"], { model: "gpt-5.4", provider: "mesh", used: 250000 }, dflt))
    .toMatchObject({ model: "mesh/gpt-5.4", used: 250000, window: 1000000 });
  // its own settings say nothing to read; an --auto-approve says full access
  expect(parseDefaults("omp", "")).toMatchObject({ model: null, effort: null });
  expect(current("omp", ["omp", "--auto-approve"], {}, {}).perm).toBe("bypassPermissions");
});
