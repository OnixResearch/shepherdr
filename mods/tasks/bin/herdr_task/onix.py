"""Onix repos: work lands on the base branch by fast-forward and a push, never a pull request, and
a task's linked Cairn change passes its read-only gates first (contract C).

The forge is per folder: the setting `onix.forge` (Everywhere's, this machine's, or the space's)
is `auto` (the default), `github` or `onix`. `auto` reads the repo: a `.cairn/` folder, or an
origin on github.com under OnixResearch or onixcomputer, is an Onix repo.

An Onix repo's merge (the person's Accept, Shepherdr's auto-merge, the Merge button):
`git fetch`, the task's branch must hold `origin/<base>` (a clean worktree is rebased onto it;
anything else stops with the reason), the base branch here fast-forwards to the task's branch,
`git push origin <base>` (never forced), then `git merge-base --is-ancestor <sha> origin/<base>`.

A task's linked Cairn change (`cairn`: its slug, set by `add --cairn` or a brief's `Cairn: <slug>`
line) is gated at ready and before Accept with Cairn's machine envelope: `gate proposal|design|
tasks <slug>` and `validate`. `ok` only means it ran: the gate's `.result.verdict` ("PASS"/"FAIL")
and validate's `.result.valid` are what count. A FAIL stops a merge; an error (no cairn here, a
policy skew) is `unknown` with why: never blocking, never read as PASS. Cairn's own sync/archive
are never run: only the read-only gates and validate.

With `onix.radicle` the work goes out as a Radicle patch instead (radicle.py): the same merge, on
the repo's rad remote, the patch given the merged commit first, then the base pushed to origin too.
"""

import json
import os
import re
import shlex
import subprocess

from . import radicle
from .base import Fail, git, now
from .settings import settings_layers

FORGES = ("auto", "github", "onix")
# An origin on github.com that is OnixResearch's or onixcomputer's, whatever the URL's shape
# (git@github.com:OnixResearch/x, https://github.com/onixcomputer/x, ssh://git@github.com/...).
ONIX_REMOTE = re.compile(r"github\.com[:/](?:OnixResearch|onixcomputer)/", re.I)
GATES = ("proposal", "design", "tasks")
# A Cairn change's slug: its folder's name under .cairn/changes (add-gates, 2026-11-18-thing).
SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
# A brief's Settings line ("- Cairn: add-gates", "Cairn: add-gates"): the Assistant links the change
# in the task's own words too. "none"/"-"/"off" say there is no linked change.
BRIEF_LINE = re.compile(r"^[ \t]*[-*]?[ \t]*Cairn[ \t]*:[ \t]*(\S+)[ \t]*$", re.I | re.M)
NO_SLUG = ("none", "no", "off", "-", "n/a")
CAIRN_TIMEOUT = 300  # seconds: a gate that hangs stops the merge path, never the person's Accept forever


# ---- which forge a folder uses --------------------------------------------------------------

def onix_settings(s, space=None):
    """The `onix` settings that reach this folder's tasks: Everywhere's, then this machine's, then
    the space working in it (settings.py's layers, as every other setting)."""
    everywhere, machine, pick = settings_layers(s, space)
    out = {}
    for layer in (everywhere, machine, pick):
        part = layer.get("onix") if isinstance(layer, dict) else None
        if isinstance(part, dict):
            out.update({k: v for k, v in part.items() if v is not None})
    return out


def onix_remote(folder):
    """A remote of the repo at folder is on github.com under OnixResearch or onixcomputer."""
    ok, out, _ = git(folder, "remote", "-v")
    return bool(ok and ONIX_REMOTE.search(out))


def looks_onix(folder):
    """A repo the Onix way by itself: it has Cairn's .cairn/ folder, or an Onix GitHub origin."""
    return os.path.isdir(os.path.join(folder, ".cairn")) or onix_remote(folder)


def forge(s, space=None):
    """`github` or `onix` for this folder's tasks. `onix.forge`'s setting wins (`auto` reads the
    repo); a plain folder and anything unknown is `github`, as before."""
    memo = getattr(s, "onix_forge", None)
    if not isinstance(memo, dict):
        memo = s.onix_forge = {}
    key = space or ""
    if key in memo:
        return memo[key]
    setting = str(onix_settings(s, space).get("forge") or "auto").strip().lower()
    if setting in ("github", "onix"):
        memo[key] = setting
    elif s.loc["kind"] != "repo":
        memo[key] = "github"
    else:
        memo[key] = "onix" if looks_onix(s.loc["folder"]) else "github"
    return memo[key]


def mode(s, space=None):
    """The tasks here merge the Onix way (onix.forge said so, or the repo said so)."""
    return forge(s, space) == "onix"


def remote_of(main):
    """The repo's remote, origin first (github.remote_of's rule, kept local: onix.py is imported by it)."""
    names = git(main, "remote")[1].split()
    return "origin" if "origin" in names else (names[0] if names else "origin")


# ---- the linked Cairn change ----------------------------------------------------------------

def link(t, slug):
    """Sets (or clears, for "") the task's linked Cairn change slug. Refused when it isn't a slug."""
    slug = (slug or "").strip().strip("`")
    if not slug:
        t.pop("cairn", None)
        t.pop("cairn_gates", None)
        return
    if not SLUG.match(slug):
        raise Fail(f"A Cairn change is named like add-gates or 2026-11-18-thing, not {slug!r}.")
    t["cairn"] = slug


def brief_cairn(text):
    """The change slug a brief's Settings line names ("Cairn: add-gates"), or None: a task added
    with an Assistant's brief that links its change in words is linked without --cairn."""
    m = BRIEF_LINE.search(text or "")
    if not m:
        return None
    slug = m.group(1).strip().strip("`").rstrip(".,;:")
    return None if slug.lower() in NO_SLUG else slug


def cairn_call(s, t, args, space=None):
    """(argv, cwd, shown) for one Cairn command in this task's repo, the repo's own Cairn first:
    the space's `onix.cairn_cmd`; `tools/cairn.mjs` (bun); the repo's generated policy; else `cairn`.
    Argument order: `<cmd> --machine <args> --root . [--policy P]`."""
    root = t.get("worktree") if t.get("worktree") and os.path.isdir(t.get("worktree")) else s.loc["folder"]
    override = str(onix_settings(s, space).get("cairn_cmd") or "").strip()
    tail = []
    if override:
        prefix = shlex.split(override)
    elif os.path.isfile(os.path.join(root, "tools", "cairn.mjs")):
        prefix = ["bun", "tools/cairn.mjs"]
    elif os.path.isfile(os.path.join(root, "cairn-policy", "generated", "cairn-policy.json")):
        prefix = ["cairn"]
        tail = ["--policy", "cairn-policy/generated/cairn-policy.json"]
    else:
        prefix = ["cairn"]
    argv = [*prefix, "--machine", *args, "--root", ".", *tail]
    return argv, root, shlex.join(argv)


def machine_run(s, t, args, space=None):
    """One Cairn command's machine envelope: (envelope or None, why it couldn't be read, the command)."""
    argv, cwd, shown = cairn_call(s, t, args, space)
    try:
        r = subprocess.run(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=CAIRN_TIMEOUT)
    except FileNotFoundError:
        return None, f"{os.path.basename(argv[0])} isn't installed here", shown
    except subprocess.TimeoutExpired:
        return None, f"it took longer than {CAIRN_TIMEOUT}s", shown
    except OSError as e:
        return None, f"couldn't start {os.path.basename(argv[0])} ({e.strerror or e})", shown
    try:
        env = json.loads(r.stdout or "null")
    except ValueError:
        env = None
    if not isinstance(env, dict) or env.get("schema_version") != "cairn.cli-machine.v1":
        said = last_line(r.stderr) or last_line(r.stdout) or f"exit {r.returncode}"
        return None, f"Cairn's answer wasn't a machine envelope ({said})", shown
    if env.get("ok") is False or not isinstance(env.get("result"), dict):
        return None, f"Cairn couldn't run it ({diag(env) or 'no result'})", shown
    return env, None, shown


def last_line(text):
    lines = [x.strip() for x in (text or "").strip().splitlines() if x.strip()]
    return lines[-1] if lines else ""


def diag(env):
    """The envelope's diagnostics in one line (its codes, never its message text as a verdict)."""
    rows = env.get("diagnostics") if isinstance(env, dict) else None
    if not isinstance(rows, list):
        return ""
    return ", ".join(str(d.get("code") or "").strip() for d in rows if isinstance(d, dict) and d.get("code"))


def check_gates(s, t, space=None):
    """The linked Cairn change's read-only gates and validate, as the machine envelope says:
    {gates: {proposal, design, tasks}, valid, why?, at, cmd}. None when no change is linked."""
    slug = str(t.get("cairn") or "").strip()
    if not slug:
        return None
    space = space or t.get("space")
    record = {"gates": {}, "valid": None, "at": now(), "cmd": None}
    why = []
    for stage in GATES:
        env, err, shown = machine_run(s, t, ["gate", stage, slug], space)
        record["cmd"] = record["cmd"] or shown
        verdict = "unknown"
        if err:
            why.append(f"{stage}: {err}")
        else:
            said = str((env.get("result") or {}).get("verdict") or "").strip().upper()
            if said in ("PASS", "FAIL"):
                verdict = said
            else:
                why.append(f"{stage}: no verdict in Cairn's answer" + (f" ({diag(env)})" if diag(env) else ""))
        record["gates"][stage] = verdict
    env, err, shown = machine_run(s, t, ["validate"], space)
    record["cmd"] = record["cmd"] or shown
    if err:
        why.append(f"validate: {err}")
    else:
        valid = (env.get("result") or {}).get("valid")
        if isinstance(valid, bool):
            record["valid"] = valid
        else:
            why.append("validate: no valid in Cairn's answer" + (f" ({diag(env)})" if diag(env) else ""))
    if why:
        record["why"] = "; ".join(why)
    return record


def gate_failures(record):
    """Why a recorded Cairn result stops a merge (a FAIL gate, or validate saying invalid), else None.
    Unknown and errors never stop one."""
    if not record:
        return None
    bad = [stage for stage in GATES if (record.get("gates") or {}).get(stage) == "FAIL"]
    if bad:
        return "Cairn gates fail: " + ", ".join(bad) + "."
    if record.get("valid") is False:
        return "Cairn validate says the change is invalid."
    return None


# ---- the Onix merge ------------------------------------------------------------------------

def merge(s, t, space=None):
    """Lands the task's branch on its base the Onix way, no pull request: fetch, the branch must
    hold origin/<base> (a clean worktree is rebased onto it, anything else stops), the base branch
    here fast-forwards to the branch, `<base>` is pushed to origin (never forced), and origin is
    asked whether it holds the commit. Returns {ok, base} plus sha and at when it merged, else why
    (and never a half-rebased worktree: a failed rebase is aborted).
    With onix.radicle (radicle.py) the remote is the repo's rad remote and only a delegate merges:
    the task's patch gets the commit before the base moves, and origin gets the base after rad. The
    patch's record comes back as `radicle` (and origin's push as `mirror`): the caller keeps it on the
    task, since the merge runs with the task list let go."""
    main = s.loc["folder"]
    base = t.get("base") or "main"
    branch = t.get("branch")
    wt = t.get("worktree") or ""
    wt_here = bool(wt) and os.path.isdir(wt)
    via = radicle.mode(onix_settings(s, space or t.get("space")), main)
    remote = (radicle.rad_remote(main) or "rad") if via else remote_of(main)
    out = {"ok": False, "base": base, **({"remote": remote} if via else {})}
    if not branch:
        return {**out, "why": "it has no branch to merge"}
    names = git(main, "remote")[1].split()
    if remote not in names:
        if via:
            return {**out, "why": f"onix.radicle wants a Radicle patch, but this repo has no rad:// remote to push {base} to"}
        return {**out, "why": f"there is no {remote} remote here to push {base} to"}
    if via:
        # Only a delegate's push moves the canonical branch: anyone else's would land nowhere.
        mine, why = radicle.delegate_here(main)
        if not mine:
            patch = ((t.get("radicle") or {}).get("patch") or "")[:7]
            return {**out, "why": f"{why}: " + (f"Radicle patch {patch} stays open for them" if patch else "a delegate merges it")}
    ok, _, err = git(main, "fetch", remote)
    if not ok:
        return {**out, "why": f"couldn't fetch {remote}: {last_line(err)}"}
    origin = f"refs/remotes/{remote}/{base}"
    if not git(main, "rev-parse", "--verify", "--quiet", origin)[0]:
        return {**out, "why": f"{remote} has no {base} branch"}

    def tip():
        got, sha, _ = git(main, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}")
        return sha if got and sha else None

    sha = tip()
    if not sha:
        return {**out, "why": f"there is no branch {branch} here"}
    if git(main, "merge-base", "--is-ancestor", sha, origin)[0]:
        # Its work is already on the base branch: nothing to push, and the task is done (a merge
        # made by hand outside Shepherdr, say).
        return {**out, "ok": True, "already": True, "sha": sha, "at": now()}
    if not git(main, "merge-base", "--is-ancestor", origin, sha)[0]:
        # Behind its base: only a clean worktree is rebased onto it (never a conflict left behind).
        if not wt_here:
            return {**out, "why": f"{branch} is behind {remote}/{base} and its worktree is gone: "
                                  f"rebase it onto {remote}/{base} by hand"}
        got, dirty, _ = git(wt, "status", "--porcelain", "--untracked-files=no")
        if not got or dirty:
            return {**out, "why": f"{branch} is behind {remote}/{base} and {wt} has uncommitted changes: "
                                  f"commit or stash them, then rebase it onto {remote}/{base} by hand"}
        got, said, re_err = git(wt, "rebase", f"{remote}/{base}")
        if not got:
            git(wt, "rebase", "--abort")
            return {**out, "why": f"{branch} doesn't rebase cleanly onto {remote}/{base}: {last_line(re_err or said)}"}
        sha = tip()
        if not sha or not git(main, "merge-base", "--is-ancestor", origin, sha)[0]:
            return {**out, "why": f"{branch} still doesn't hold {remote}/{base} after rebasing"}
    out["sha"] = sha
    rec = None
    if via:
        # The patch holds exactly what lands (a rebase made a new commit): Radicle counts it merged
        # when the canonical base reaches its head.
        rec, why = radicle.push_patch(s, t, sha)
        if why:
            return {**out, "why": why}
        out["radicle"] = rec
    got, cur, _ = git(main, "symbolic-ref", "--short", "HEAD")
    if got and cur == base:
        got, said, err = git(main, "merge", "--ff-only", sha)
        if not got:
            return {**out, "why": f"couldn't fast-forward {base} here: {last_line(err or said)}"}
    else:
        exists = git(main, "show-ref", "--verify", "--quiet", f"refs/heads/{base}")[0]
        if exists and not git(main, "merge-base", "--is-ancestor", base, sha)[0]:
            return {**out, "why": f"{base} here has commits {branch} doesn't: merge it by hand"}
        if not exists:
            got, said, err = git(main, "branch", "--track", base, origin)
            if not got:
                return {**out, "why": f"couldn't make a local {base}: {last_line(err or said)}"}
        got, said, err = git(main, "branch", "-f", base, sha)
        if not got:
            return {**out, "why": f"couldn't move {base} here forward: {last_line(err or said)}"}
    got, said, err = git(main, "push", remote, f"refs/heads/{base}:refs/heads/{base}")
    if not got:
        return {**out, "why": f"couldn't push {base} to {remote}: {last_line(err or said)}"}
    git(main, "fetch", remote, base)
    if not git(main, "merge-base", "--is-ancestor", sha, origin)[0]:
        return {**out, "why": f"{remote}/{base} doesn't have {sha[:7]} after the push"}
    if via:
        out["radicle"] = radicle.landed(main, rec, sha)
        mirror = "origin"
        if mirror != remote and mirror in names:
            # origin (a GitHub mirror) in step with the canonical base; its failure is said, the merge stands
            got, said, err = git(main, "push", mirror, f"refs/heads/{base}:refs/heads/{base}")
            out["mirror"] = {"remote": mirror, "ok": got, **({} if got else {"why": last_line(err or said)})}
    out.update(ok=True, at=now())
    return out
