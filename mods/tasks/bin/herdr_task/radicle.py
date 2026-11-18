"""onix: Radicle patches as an Onix repo's merge path (the setting `onix.radicle`).

With onix.radicle "patch" (or "auto", in a repo this machine's Radicle knows), a task's work goes out
as a Radicle patch rather than a push of its base branch. At Ready its branch is pushed to the repo's
rad remote as a patch (`git push rad <branch>:refs/patches`, titled with the task), or as a new
revision of the patch it opened before. Accept merges the patch the way Radicle merges one: a
delegate's canonical branch moves to it. The task's branch is rebased onto rad/<base> first when
that is clean (the patch then gets that revision, so the commit Radicle sees merged is the one the
patch holds), the base branch here fast-forwards to it, `<base>` is pushed to rad (never forced) and
Radicle records the patch merged; the base goes to origin too when the repo has one, so a GitHub
mirror stays in step (a failure there is said, and the merge stands).

Only a delegate's push moves a canonical branch, so Accept refuses when this machine's Radicle
identity isn't one of the repo's delegates: the patch stays open for them. Nothing here starts the
Radicle node; without it the patch and the merge stay on this machine until it runs (the task says so).

What it keeps on the task is `radicle`: {patch, rid, head, at, offline?, state?, merged_sha?}. These
functions return that record and never write the task: the merge runs with the task list's lock let
go (store.released), which reads every task again after it.
"""

import json
import os
import re
import subprocess

from .base import git, now

MODES = ("off", "patch", "auto")
RAD_TIMEOUT = 120  # seconds for one rad or git-over-rad call (a push signs and may announce)
PATCH_OPENED = re.compile(r"Patch ([0-9a-f]{40}) opened")
DID = re.compile(r"^(did:key:z[1-9A-HJ-NP-Za-km-z]+)", re.M)


def rad(folder, *args, timeout=RAD_TIMEOUT):
    """(ok, stdout, stderr) of `rad <args>` in folder; never raises (no rad here is a plain no)."""
    try:
        r = subprocess.run(["rad", *args], cwd=folder, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, "", str(e)
    return r.returncode == 0, r.stdout.strip(), r.stderr.strip()


def rad_remote(folder):
    """The repo's Radicle remote: the one named rad when it fetches rad://, else the first that does."""
    ok, out, _ = git(folder, "remote", "-v")
    found = [line.split()[0] for line in (out.splitlines() if ok else [])
             if len(line.split()) >= 2 and line.split()[1].startswith("rad://") and line.endswith("(fetch)")]
    return "rad" if "rad" in found else (found[0] if found else None)


def rid(folder):
    """The repo's Radicle id (rad:z…) when this machine's Radicle storage has it, else None."""
    ok, out, _ = rad(folder, ".")
    return out if ok and out.startswith("rad:") else None


def mode(settings_onix, folder):
    """"patch" when this folder's tasks go out as Radicle patches, else None. onix.radicle: "patch" (the
    repo must have a rad remote: refused at merge time with why otherwise), "auto" (a rad remote whose
    repo this machine's Radicle knows), "off" (the default)."""
    want = str(settings_onix.get("radicle") or "off").strip().lower()
    if want == "patch":
        return "patch"
    if want == "auto" and rad_remote(folder) and rid(folder):
        return "patch"
    return None


def delegate_here(folder):
    """(is this machine's Radicle identity a delegate of the repo, why not)."""
    ok, me, err = rad(folder, "self", "--did")
    if not ok or not me.startswith("did:"):
        return False, f"no Radicle identity here ({last(err) or 'rad self failed'})"
    ok, out, err = rad(folder, "inspect", "--delegates")
    if not ok:
        return False, f"couldn't read the repo's delegates ({last(err) or 'rad inspect failed'})"
    if me.strip() not in DID.findall(out):
        return False, "this machine's Radicle identity isn't one of the repo's delegates"
    return True, None


def node_running(folder):
    ok, out, _ = rad(folder, "node", "status", timeout=30)
    return ok and "is running" in out


def last(text):
    lines = [x.strip() for x in (text or "").strip().splitlines() if x.strip()]
    return lines[-1] if lines else ""


def patch_message(s, t):
    """The patch's title and description: the task's own words (its title, and its summary when ready gave one)."""
    title = f"{s.ref(t)}: {t.get('title') or 'task'}".strip()
    body = str(t.get("summary") or "").strip()
    return title, body


def patch_state(folder, rid_, patch):
    """(status, head of its latest revision) of a patch from its COB, or (None, None) when unreadable."""
    ok, out, _ = rad(folder, "cob", "show", "--repo", rid_, "--type", "xyz.radicle.patch", "--object", patch, timeout=60)
    try:
        d = json.loads(out) if ok else None
    except ValueError:
        d = None
    if not isinstance(d, dict):
        return None, None
    status = (d.get("state") or {}).get("status")
    revs = d.get("revisions") if isinstance(d.get("revisions"), dict) else {}
    # its revisions in the order they came (timestamps tie within a second): the latest is the last
    order = [r for r in (d.get("timeline") or []) if isinstance(r, str) and isinstance(revs.get(r), dict)]
    head = revs[order[-1]].get("oid") if order else None
    return (status if isinstance(status, str) else None), head


def push_patch(s, t, sha):
    """Opens the task's patch at `sha`, or gives the one it has a new revision there: (its `radicle`
    record, None), or (None, why not)."""
    main = s.loc["folder"]
    remote = rad_remote(main)
    if not remote:
        return None, "this repo has no rad:// remote to open a Radicle patch on"
    rid_ = rid(main)
    if not rid_:
        return None, f"this machine's Radicle doesn't have the repo {remote} points at (rad clone it, or rad init)"
    rec = t.get("radicle") if isinstance(t.get("radicle"), dict) else {}
    title, body = patch_message(s, t)
    opts = ["-o", f"patch.message={title}"] + (["-o", f"patch.message={body}"] if body else [])
    if rec.get("patch") and rec.get("rid") == rid_:
        if rec.get("head") == sha:
            return dict(rec), None
        # A new revision of the same patch: its own branch on the remote, moved (rad's way to update one).
        ok, said, err = git(main, "push", "--force", *opts, remote, f"{sha}:refs/heads/patches/{rec['patch']}")
        if not ok:
            return None, f"couldn't update Radicle patch {rec['patch'][:7]}: {last(err or said)}"
        patch = rec["patch"]
    else:
        ok, said, err = git(main, "push", *opts, remote, f"{sha}:refs/patches")
        m = PATCH_OPENED.search(f"{said}\n{err}")
        if not ok or not m:
            return None, f"couldn't open a Radicle patch: {last(err or said) or 'no patch id in its answer'}"
        patch = m.group(1)
    return {"patch": patch, "rid": rid_, "head": sha, "at": now(), **({} if node_running(main) else {"offline": True})}, None


def landed(folder, rec, sha):
    """The record after the base was pushed to rad, with what Radicle says of the patch now (`merged`
    when the canonical base reached its head)."""
    status, _ = patch_state(folder, rec["rid"], rec["patch"])
    return {**rec, "state": status or "unknown", "merged_sha": sha}
