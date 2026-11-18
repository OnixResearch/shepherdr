# The OnixResearch fork

This fork of [eliasstravik/shepherdr](https://github.com/eliasstravik/shepherdr) runs Shepherdr on the
OnixResearch stack: agents on omp with Underclass and mesh-llm models, the pool and the mesh in plan limits, and
the OnixResearch repo rules (Cairn, fast-forward merges, Kiln). Everything else is upstream Shepherdr: install it,
use it and update it the same way ([Install](install.md)).

## What differs

| | Upstream | This fork |
|---|---|---|
| Agent CLIs | Claude Code, Codex | Claude Code, Codex and **omp**, for the Assistant, workers, the reviewer and the backup agent |
| Models | each CLI's own sign-in | for omp, any chat model omp knows from the providers you allow: `underclass/…` (the account pool) and `mesh/…` (mesh-llm) by default |
| Plan limits | Claude Code's `/usage`, Codex's rate limits | also the **Underclass pool** (headroom per backend, banked resets) and **mesh-llm** (models and peers) |
| Merging | a pull request on GitHub, else a local merge | in an **Onix repo**: no pull request; after Accept, fast-forward the base branch and push it |
| Checks | GitHub checks on the pull request | in an Onix repo: the linked **Cairn change's gates** at Ready, and **Kiln's CI** for the merged commit |
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
- The role instructions tell agents to follow each repo's own AGENTS.md and CONTRIBUTING.md: its pinned tools,
  its Cairn change, its declared gates, no pull requests, no force-push and no Radicle push.

## Settings

All in `~/.config/shepherdr/settings.json`, beside the upstream ones (`everywhere`, or a space's own `spaces.<id>`):

```json
{
  "everywhere": {
    "onix": {
      "omp_providers": ["underclass", "mesh"],
      "forge": "auto",
      "kiln": { "machine": "<herdr-core machine name>", "db": "~/git/.kiln-web-service/web-live/service.sqlite" }
    }
  },
  "spaces": { "<space id>": { "onix": { "forge": "onix", "cairn_cmd": "bun tools/cairn.mjs" } } }
}
```

## Not in this fork (yet)

- Claude Code or Codex sent through Underclass: omp already reaches `underclass/claude-…` and the Codex models.
- Radicle patches instead of pushing the base branch.
- Kiln checks before a merge: Kiln builds only `main` today.

## Keeping up with upstream

```bash
git fetch upstream
git merge upstream/main        # this fork's own changes are marked `onix:` where they touch upstream files
python3 bin/sync-shared --check && python3 -m unittest discover -s test
```

Keep upstream files' changes small and marked, and put new behaviour in new files, so upstream releases merge
cleanly. Names of the machines and accounts this fork runs on never go in it: `test/test_repo.py` checks the code
against a local, untracked `test/private-patterns.txt`.
