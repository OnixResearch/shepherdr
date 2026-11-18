import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AGENT_ENV, AGENT_PATH, CLEAN_ENV, cleanCommand } from "./clean-env.js";

// SHEP-86: an Assistant's one-off template command runs under sh -c in the holder's environment. Fake values only.
// omp's markers too (PI_SESSION_FILE, PI_SESSION_ID, OMPCODE): started from inside another omp it would attach to that
// session's file, and OMPCODE=1 silences its herdr status extension.
const parent = { PATH: process.env.PATH, CLAUDECODE: "1", CLAUDE_PID: "4242", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "fake-session",
  CLAUDE_CODE_MESSAGING_TOKEN: "fake-token", CLAUDE_CONFIG_DIR: "/tmp/fake-claude", CLAUDE_CODE_USE_BEDROCK: "1", FAKE_OTHER: "x",
  PI_SESSION_FILE: "/tmp/fake-omp-session.jsonl", PI_SESSION_ID: "fake-omp-id", OMPCODE: "1", PI_SMOL_MODEL: "mesh/gpt-5.4" };

test("an Assistant's command runs without a parent Claude Code or omp session's markers, keeping the person's config", () => {
  const r = Bun.spawnSync(["sh", "-c", cleanCommand("env")], { env: parent });
  const env = Object.fromEntries(r.stdout.toString().trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  for (const k of ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_TOKEN", "PI_SESSION_FILE", "PI_SESSION_ID", "OMPCODE"]) expect(env[k]).toBeUndefined();
  // the person's own settings stay: Claude Code's config, and omp's model choices in the environment
  expect([env.CLAUDE_CONFIG_DIR, env.CLAUDE_CODE_USE_BEDROCK, env.PI_SMOL_MODEL, env.FAKE_OTHER]).toEqual(["/tmp/fake-claude", "1", "mesh/gpt-5.4", "x"]);
});

test("the agent is exec'd once, whether the template's command had exec or not", () => {
  expect(cleanCommand("claude --model opus")).toBe(`${CLEAN_ENV} ${AGENT_ENV} ${AGENT_PATH} exec claude --model opus`);
  expect(cleanCommand("exec claude")).toBe(`${CLEAN_ENV} ${AGENT_ENV} ${AGENT_PATH} exec claude`);
});

test("a holder started over ssh (PATH only /usr/bin:/bin) still finds an agent in ~/.local/bin (GitHub #839)", () => {
  const home = mkdtempSync(`${tmpdir()}/clean-env-`);
  try {
    mkdirSync(`${home}/.local/bin`, { recursive: true });
    writeFileSync(`${home}/.local/bin/fake-agent`, "#!/bin/sh\necho started \"$@\"\n", { mode: 0o755 });
    const r = Bun.spawnSync(["/bin/sh", "-c", cleanCommand("fake-agent --model opus")], { env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
    expect([r.exitCode, r.stdout.toString().trim()]).toEqual([0, "started --model opus"]);
    // the holder's own PATH comes first: an agent it already finds is the one that runs
    const own = `${home}/own`;
    mkdirSync(own);
    writeFileSync(`${own}/fake-agent`, "#!/bin/sh\necho own\n", { mode: 0o755 });
    expect(Bun.spawnSync(["/bin/sh", "-c", cleanCommand("fake-agent")], { env: { HOME: home, PATH: `${own}:/usr/bin:/bin` } }).stdout.toString().trim()).toBe("own");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
