# The OnixResearch fork

This fork of [eliasstravik/shepherdr](https://github.com/eliasstravik/shepherdr) runs Shepherdr on the
OnixResearch stack: agents on omp with Underclass and mesh-llm models (and Claude Code and Codex on the Underclass
pool), the pool and the mesh in plan limits, and the OnixResearch repo rules (Cairn, fast-forward merges or Radicle
patches, Kiln before and after a merge). Everything else is upstream Shepherdr: install it, use it and update it the
same way ([Install](install.md)).

## What differs

| | Upstream | This fork |
|---|---|---|
| Agent CLIs | Claude Code, Codex | Claude Code, Codex and **omp**, for the Assistant, workers, the reviewer and the backup agent |
| Models | each CLI's own sign-in | for omp, any chat model omp knows from the providers you allow: `underclass/…` (the account pool) and `mesh/…` (mesh-llm) by default; Claude Code and Codex on the **Underclass pool** instead of their own sign-in, when you switch it on |
| Plan limits | Claude Code's `/usage`, Codex's rate limits | also the **Underclass pool** (headroom per backend, banked resets) and **mesh-llm** (models and peers) |
| Merging | a pull request on GitHub, else a local merge | in an **Onix repo**: no pull request; after Accept, fast-forward the base branch and push it, or merge the task's **Radicle patch** |
| Checks | GitHub checks on the pull request | in an Onix repo: the linked **Cairn change's gates** at Ready, **Kiln's CI** on the task before it merges, and Kiln's CI for the merged commit |
| Side panel | Files, Changes, Tasks, Artifacts | also **Kiln**: Kiln's CI pages as on its website (overview, runs and what each ran, CI projects, workers), with start, cancel and rerun |
| Keys | some panes keys in every layout | `Ctrl+K`, `Alt+Enter`, `Alt+Shift+Enter`, `Alt+Esc` and `Ctrl+Alt+arrows` only in the Shepherdr layout, so terminal programs keep them elsewhere |

## omp agents

Pick omp in Shepherdr settings › Agents for any role, then its model (`underclass/claude-opus-5-5`,
`mesh/Qwen3.8-27B`, …), thinking level and permissions. Shepherdr starts it as
`omp --model <provider>/<id> --thinking <level> --approval-mode <mode>`:

| Permissions | omp approval mode |
|---|---|
| Ask (manual) | `always-ask-cached` |
| Auto | `write` |
| Full access | `yolo` |

- The model list is `omp models --json`, chat models only, from the providers in `onix.omp_providers`
  (default `["underclass", "mesh"]`). A model id with a `:` in it can't be picked (omp reads `model:level` as a
  thinking level), except `…:free`.
- Shepherdr starts every agent without `PI_SESSION_FILE`, `PI_SESSION_ID` and `OMPCODE`: an omp started from inside
  another omp session would otherwise attach to that session, or stop reporting its status to Herdr.
- The chat reads omp's own session log (`~/.omp/agent/sessions/…`), following its branches: a rewound
  conversation shows only the live branch.
- Resume uses `omp --resume <session>`, and a crashed agent comes back with `omp --restore <session>`. omp can't
  fork a session, so a fork is a handoff with the log.
- **Limits of omp in Shepherdr:** omp has no read-only sandbox. An omp reviewer starts with
  `--approval-mode always-ask`: it reads freely and would ask before any write or command, so its instructions tell
  it to run nothing and name the checks for its worker to run, as a Codex reviewer does for what its sandbox can't
  run. omp's questions and permission prompts are answered in its terminal, not on a chat card; the task shows
  under Needs you meanwhile.
- Workers get their own `herdr-task` (and `herdr-secret`, `herdr-browser`) commands approved through a per-run
  `--config` overlay of omp `bash.patterns`, the way Claude Code workers get allow rules, so Ask and Auto don't stop
  a worker at its own status and ready calls.

## Claude Code and Codex through the Underclass pool

Settings › Agents › **Claude Code through Underclass** and **Codex through Underclass** (Everywhere's, the setting
`onix.underclass`: a list of CLIs) start that CLI on the pool's proxy instead of this computer's own sign-in:
the Assistant, workers, the reviewer and the backup agent alike.

- Claude Code gets the proxy's address and an `apiKeyHelper` in its `--settings`
  (`{"apiKeyHelper": "herdr-task underclass-key", "env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:8080"}}`). Codex gets
  a model provider of its own on the proxy's Responses API
  (`-c model_provider="underclass" -c model_providers.underclass={…, auth={command="herdr-task", args=["underclass-key"]}}`).
- The key is read when the agent needs it, on the agent's own machine, by `herdr-task underclass-key`: the machine's
  `onix.underclass_key_cmd` (a shell command printing it), else Everywhere's, else omp's own Underclass provider
  (`~/.omp/agent/extensions/underclass/provider.json`, whose `apiKey` is such a command). No key is ever in an
  argv, a template, a task or the settings file.
- The address is `onix.underclass_url` (default `http://127.0.0.1:8080`, Underclass's own; a machine without the pool
  reaches it through a tunnel on that port).
- A pooled CLI needs no sign-in of its own: the reviewer pick and the backup agent don't fall back for one that is
  signed out. Its model is the pool's: a Codex model the pool has no headroom for gets the pool's 429.
- A resumed or forked conversation keeps going through the pool; a switch follows the setting. A Codex worker's
  reviewer escalation admits only the pool's exact flags (its address and `herdr-task underclass-key`).

## The Underclass pool and mesh-llm in plan limits

Plan limits show on each machine's meter in the sidebar and in its details (Shepherdr reads them every 10 minutes).
On each machine Shepherdr also reads, when they are there:

- **Underclass:** the monitor socket (`/run/underclass/monitor.sock`, or `SHEPHERDR_UNDERCLASS_MONITOR`). For each
  backend (Codex, Claude, OpenCode Go) it shows the best account's headroom per window, so one spent account doesn't
  hide the others; when every account of a backend is spent, the window shows the earliest reset, when headroom comes
  back. It also counts the accounts and the banked Codex resets, and never shows account names.
- **mesh-llm:** the console on `127.0.0.1:3131` (or `SHEPHERDR_MESH_CONSOLE`): the node's state, peers, and the
  models it serves. Never its invite token.

Both are read on the machine itself, through herdr-core, like the rest of the machine's health: nothing is sent
anywhere else and no key is needed.

## Onix repos

A task's repo is an **Onix repo** when it has a `.cairn/` folder or its `origin` is under `OnixResearch/` or
`onixcomputer/` on GitHub. Set `onix.forge` to `github` or `onix` to choose for every repo or one space.

- **Merging:** no pull request. On the person's Accept (or by itself when the Merge setting allows), Shepherdr
  fetches, fast-forwards the base branch to the task's branch (rebasing it first only when that is clean) and
  pushes the base, never with `--force`. A task that can't fast-forward goes back to Needs you with the reason.
- **Radicle patches:** with `onix.radicle` set to `patch` (or `auto`: a repo whose rad remote this machine's Radicle
  has), the work goes out as a Radicle patch instead of a push to origin. At Ready Shepherdr pushes the task's
  branch to the repo's rad remote as a patch (`git push rad <commit>:refs/patches`, titled with the task). Accept
  merges it the Radicle way: the branch is rebased onto `rad/<base>` when that is clean and the patch gets that commit
  as a new revision, the base fast-forwards and goes to rad (never forced), and Radicle records the patch merged;
  then the base goes to origin too, when the repo has one, so a GitHub mirror stays in step (a failure there is said
  on the task; the merge stands). Only a delegate's push moves a Radicle repo's canonical branch, so Accept refuses
  when this machine's Radicle identity isn't one of the repo's delegates, and the patch stays open for them.
  Shepherdr never starts the Radicle node: without it the patch and the merge stay on this machine until the node
  runs and announces them (the task says so).
- **Cairn:** a task can name its Cairn change (`herdr-task add … --cairn <slug>`, or a `Cairn: <slug>` line in the
  task's prompt), and its worker's brief then names it in the Settings block. At Ready and before Accept, Shepherdr
  runs the change's read-only gates (`gate proposal`, `gate design`, `gate tasks`) and `validate`, and shows the
  verdicts on the Accept card. A failing gate holds the merge like a failing check; a gate that couldn't run (tool or
  policy mismatch) shows why and holds nothing. Shepherdr never runs `sync` or `archive`.
- **Which `cairn`:** the space's `onix.cairn_cmd` when set; else `bun tools/cairn.mjs` when the repo has it; else
  `cairn` with the repo's `cairn-policy/generated/cairn-policy.json` when it has one; else `cairn`.
- **Kiln:** with `onix.kiln.machine` set to the herdr-core machine that runs Kiln, Shepherdr follows Kiln's CI for
  each commit it merged (every 2 minutes, for up to 2 hours), shows the outcome on the task and tells the space's
  Assistant, also when no run settled within the 2 hours ("unknown", never "passed"). It reads Kiln's state
  read-only on that machine (`onix.kiln.db`, default `~/git/.kiln-web-service/web-live/service.sqlite`) through
  `hc exec`; Kiln builds only the branches its projects name (`main` today). Kiln runs its workflows on Lattice;
  Shepherdr only asks Kiln.
- **Kiln before a merge:** with `onix.kiln.before_merge` on too, a Ready task's work is checked by Kiln before it
  merges. Kiln builds only its project's branch, so the run is that branch's tip on the Kiln machine with the task's
  changes on top, sent as Kiln's own dirty selection (`kiln-web-service ci submit --dirty-repository … --include …
  --delete …`): the task's diff goes over `hc exec`, is applied in a scratch copy of the project's repository there
  (removed after), and nothing is pushed anywhere. The project is `onix.kiln.project`, else the Kiln project whose
  repository has the repo's folder name. The checks row on the Accept card shows the run. A pass lets the merge go
  (Accept while it runs waits and merges once Kiln passes, as the Merge setting's auto and checks do); a failure is
  Needs you with the run and its outcome, and holds the merge like a failing Cairn gate; a check that couldn't happen
  (Kiln unreachable, its branch tip not in this repo, the changes don't apply, no answer in 2 hours) shows why and
  holds nothing. A new head is checked again. The developer CLI uses `onix.kiln.developer`
  (default `~/.config/kiln/developer.json`, a `kiln.web-developer.v1` profile on the Kiln machine) pinned by
  `onix.kiln.identity` (the BLAKE3 of its bytes; unset, `b3sum` of it there). A rebase at merge time can land on a
  newer base than the one Kiln checked.
  Kiln must be able to execute a dirty selection: its own workers rebuild the snapshot from Kiln's store; a project
  whose execution provider can't (a Lattice workflow whose job binary is gone, say) gets the run marked
  `unknown` (`provider_unknown`) at once. An unknown run keeps its project busy in Kiln until an operator reconciles
  it there, so the check reads Kiln's `unknown` as unknown (holding nothing) and sends nothing more for a project
  that has one, saying which run holds it.
- **Kiln panel:** the tab bar's Kiln (the Kiln CI add-on; Shepherdr settings › Window can switch it off) shows Kiln's
  CI as its website does: Overview (failing projects first, what's in progress, what passed, worker capacity, recent
  activity), Runs (filters, then a run's pipeline, logs, artifacts, tests and coverage, Patchgate reviews, comparison,
  activity and evidence), CI projects (start a run, enroll a project, a project's history) and Workers. Its expand
  button opens the same in a bigger window. It talks to Kiln's own API at `onix.kiln.url` (Kiln's website,
  `https://host:port`) over the tailnet, where Kiln's proxy signs this machine in by its Tailscale identity as it
  does a browser; `onix.kiln.ca` is a copy of Kiln's CA certificate on this computer when Kiln's certificate is its
  own. While it is on screen it follows Kiln live (every 1.5 s, as the website). Start, cancel, approve and rerun
  need Kiln's operate permission; cancel, approve and rerun are asked first in the website's words, and every
  request is sent once and never retried. The web app has Kiln at the sidebar's foot: it opens Kiln's website.
- The role instructions tell agents to follow each repo's own AGENTS.md and CONTRIBUTING.md: its pinned tools,
  its Cairn change, its declared gates, no pull requests, no force-push and no Radicle push (Shepherdr opens and
  merges a task's patch itself).

## Settings

All in `~/.config/shepherdr/settings.json`, beside the upstream ones (`everywhere`, or a space's own `spaces.<id>`):

```json
{
  "everywhere": {
    "onix": {
      "omp_providers": ["underclass", "mesh"],
      "underclass": ["claude", "codex"],
      "underclass_url": "http://127.0.0.1:8080",
      "forge": "auto",
      "radicle": "off",
      "kiln": { "machine": "<herdr-core machine name>", "db": "~/git/.kiln-web-service/web-live/service.sqlite",
                "before_merge": true, "developer": "~/.config/kiln/developer.json", "identity": "<b3sum of it>",
                "url": "https://<kiln host>:9443", "ca": "~/.config/shepherdr/kiln-ca.pem" }
    }
  },
  "machines": { "<machine>": { "onix": { "underclass_key_cmd": "cat /run/secrets/…/proxy-key" } } },
  "spaces": { "<space id>": { "onix": { "forge": "onix", "cairn_cmd": "bun tools/cairn.mjs", "radicle": "patch",
                                        "kiln": { "project": "<kiln project id>" } } } }
}
```

## Keeping up with upstream

```bash
git fetch upstream
git merge upstream/main        # this fork's own changes are marked `onix:` where they touch upstream files
python3 bin/sync-shared --check && python3 -m unittest discover -s test
```

Keep upstream files' changes small and marked, and put new behaviour in new files, so upstream releases merge
cleanly. Names of the machines and accounts this fork runs on never go in it: `test/test_repo.py` checks the code
against a local, untracked `test/private-patterns.txt`.
