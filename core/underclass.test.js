// onix: Claude Code and Codex through the Underclass pool (core/agents.js underclassOf, withUnderclass, argvFor).
import { expect, test } from "bun:test";
import { argvFor, forkArgv, resumeArgv, underclassIn, underclassOf, withUnderclass, UNDERCLASS_URL } from "./agents.js";
import { backupProblemFor, underclassList, underclassWith } from "./settings.js";

const FILE = { everywhere: { onix: { underclass: ["claude", "codex"] } } };
const settingsOf = (argv) => JSON.parse(argv[argv.indexOf("--settings") + 1]);
const configs = (argv) => argv.flatMap((a, i) => (a === "-c" ? [argv[i + 1]] : []));

test("the setting names the CLIs that go through the pool, at its own address or Underclass's default", () => {
  expect(underclassOf({})).toEqual({ claude: false, codex: false });
  expect(underclassOf(FILE)).toEqual({ claude: UNDERCLASS_URL, codex: UNDERCLASS_URL });
  const other = { everywhere: { onix: { underclass: ["Codex"], underclass_url: "http://10.0.0.5:9090/" } } };
  expect(underclassOf(other)).toEqual({ claude: false, codex: "http://10.0.0.5:9090" });
  // an address that isn't http(s) is never put in an agent's settings
  expect(underclassOf({ everywhere: { onix: { underclass: ["claude"], underclass_url: "file:///etc" } } }).claude).toBe(UNDERCLASS_URL);
  expect(underclassList(FILE)).toEqual(["claude", "codex"]);
  expect(underclassWith(["claude"], "codex", true)).toEqual(["claude", "codex"]);
  expect(underclassWith(["claude", "codex"], "claude", false)).toEqual(["codex"]);
});

test("Claude Code through the pool: the proxy's address and the key's command in its --settings, never a key", () => {
  const { argv } = argvFor(withUnderclass({ agent: "claude", model: "opus", fast: true, perm: "auto" }, FILE), { agent: null, argv: [] });
  expect(settingsOf(argv)).toEqual({ fastMode: true, apiKeyHelper: "herdr-task underclass-key", env: { ANTHROPIC_BASE_URL: UNDERCLASS_URL } });
  expect(underclassIn("claude", argv)).toBe(UNDERCLASS_URL);
  const own = argvFor(withUnderclass({ agent: "claude", model: "opus" }, {}), { agent: null, argv: [] }).argv;
  expect(settingsOf(own)).toEqual({ fastMode: false });
  expect(underclassIn("claude", own)).toBe(null);
});

test("Codex through the pool: a model provider of its own on the proxy's Responses API, its key by command", () => {
  const { argv } = argvFor(withUnderclass({ agent: "codex", model: "gpt-5.5", effort: "high", perm: "auto" }, FILE), { agent: null, argv: [] });
  expect(configs(argv)).toContain('model_provider="underclass"');
  expect(configs(argv)).toContain('model_providers.underclass={name="Underclass",base_url="http://127.0.0.1:8080/v1",wire_api="responses",'
    + 'auth={command="herdr-task",args=["underclass-key"]}}');
  expect(underclassIn("codex", argv)).toBe(UNDERCLASS_URL);
  expect(underclassIn("codex", argvFor({ agent: "codex", model: "gpt-5.5" }, { agent: null, argv: [] }).argv)).toBe(null);
});

test("a switch keeps the pool when the pick doesn't say, follows Settings when it does, and never says it twice", () => {
  const routed = argvFor(withUnderclass({ agent: "codex", model: "gpt-5.5" }, FILE), { agent: null, argv: [] }).argv;
  const kept = argvFor({ agent: "codex", model: "gpt-6-sol" }, { agent: "codex", argv: routed }).argv;
  expect(configs(kept).filter((c) => c.startsWith("model_provider=")).length).toBe(1);
  expect(underclassIn("codex", kept)).toBe(UNDERCLASS_URL);
  const again = argvFor(withUnderclass({ agent: "codex", model: "gpt-6-sol" }, FILE), { agent: "codex", argv: routed }).argv;
  expect(configs(again).filter((c) => c.startsWith("model_provider")).length).toBe(2);
  const off = argvFor(withUnderclass({ agent: "codex", model: "gpt-6-sol" }, {}), { agent: "codex", argv: routed }).argv;
  expect(configs(off).some((c) => c.startsWith("model_provider"))).toBe(false);
  // another CLI never inherits it: Settings say for each
  const claude = argvFor({ agent: "claude", model: "opus" }, { agent: "codex", argv: routed }).argv;
  expect(underclassIn("claude", claude)).toBe(null);
  // omp has its own providers: the setting never touches it
  expect(withUnderclass({ agent: "omp", model: "underclass/x" }, FILE)).toEqual({ agent: "omp", model: "underclass/x" });
});

test("a resumed or forked conversation goes on through the pool", () => {
  const claude = argvFor(withUnderclass({ agent: "claude", model: "opus" }, FILE), { agent: null, argv: [] }).argv;
  expect(underclassIn("claude", resumeArgv("claude", claude, "11111111-2222-3333-4444-555555555555"))).toBe(UNDERCLASS_URL);
  expect(underclassIn("claude", forkArgv("claude", claude, "11111111-2222-3333-4444-555555555555"))).toBe(UNDERCLASS_URL);
  const codex = argvFor(withUnderclass({ agent: "codex", model: "gpt-5.5" }, FILE), { agent: null, argv: [] }).argv;
  const resumed = resumeArgv("codex", codex, "11111111-2222-3333-4444-555555555555");
  expect(resumed.slice(0, 2)).toEqual(["codex", "resume"]);
  expect(underclassIn("codex", resumed)).toBe(UNDERCLASS_URL);
  const forked = forkArgv("codex", codex, "11111111-2222-3333-4444-555555555555");
  expect(underclassIn("codex", forked)).toBe(UNDERCLASS_URL);
  expect(configs(forked).filter((c) => c.startsWith("model_provider=")).length).toBe(1);
});

test("the backup row doesn't call a CLI through the pool signed out", () => {
  const checks = { "": { claude: "signed-out", codex: "missing" } };
  expect(backupProblemFor(checks, null, "claude", {})).toContain("signed out");
  expect(backupProblemFor(checks, null, "claude", FILE)).toBe("");
  expect(backupProblemFor(checks, null, "codex", FILE)).toContain("not installed");
});
