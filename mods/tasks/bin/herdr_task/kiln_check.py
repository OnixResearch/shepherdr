"""onix: Kiln checks a task before it merges (the setting `onix.kiln.before_merge`).

kiln.py follows Kiln's CI for a commit after it merged. This checks the task's work before: once a
task in an Onix repo is Ready, its changes go to Kiln as a run of the repo's Kiln project. Kiln builds
only the branch its project names (main), so the run is that branch's tip, on the machine Kiln runs
on, with the task's changes on top, sent as Kiln's own dirty selection (`kiln-web-service ci submit
--dirty-repository … --include/--delete`): Kiln binds the bytes, the exact base and a synthetic
revision, and builds what the merge would give. Nothing is pushed anywhere for it: the task's diff
goes over `hc exec` (stdin), is applied in a scratch copy of the project's repository there, and the
scratch copy is removed.

Settings (Shepherdr settings' `onix.kiln`, Everywhere's, this machine's or the space's):
  machine       the hc machine Kiln runs on (unset: off, as kiln.py)
  before_merge  true: check before merging (default false)
  project       the Kiln project for this folder (default: the one whose repository is named as the
                repo's folder)
  service       Kiln's service profile there (default ~/.config/kiln/web-service/service.json)
  developer     the developer CLI's profile there (default ~/.config/kiln/developer.json), and
  identity      the BLAKE3 of its bytes, as the CLI pins it (default: b3sum of it, there)

What it keeps on the task is `kiln_check`: {head, outcome, at, project?, base?, run?, phase?, why?},
outcome pending | success | failure | unknown | none (Kiln has no project for this repo). A failure
holds the merge: the task goes to Needs you with why. Pending makes a merge wait: it goes by itself
once Kiln passes (the person's Accept, or the merge setting's auto and checks). Unknown (Kiln couldn't
be asked, the changes don't apply to its base, or a run ended without an answer or none came in 2
hours) is shown with why and holds nothing, as a Cairn gate that couldn't run. A new head (the agent
fixed something) is checked again.
"""

import json
import os
import re
import subprocess

from .base import git, now
from .settings import settings_layers

EVERY_MS = 2 * 60 * 1000          # a run is asked about at most this often, and a failed submit tried again
WINDOW_MS = 2 * 3600 * 1000       # a run with no answer this long after it was asked for: unknown
HC_TIMEOUT = 300                  # seconds for one call on Kiln's machine (hc exec allows 600)
MAX_DIFF = 8 * 1024 * 1024        # the most bytes of changes sent (Kiln's requests are bounded at 16 MiB)
DEFAULT_SERVICE = "~/.config/kiln/web-service/service.json"
DEFAULT_DEVELOPER = "~/.config/kiln/developer.json"
DEFAULT_DB = "~/git/.kiln-web-service/web-live/service.sqlite"
SETTLED = ("success", "failure", "unknown", "none")
B3 = re.compile(r"^[0-9a-f]{64}$")

# ---- on Kiln's machine ---------------------------------------------------------------------------
# Each is one `python3 -c` through `hc exec --on <machine>`, answering one JSON line.

# The project for this repo and its branch's tip: {project, reference, base} or {none} or {error}; {stuck}
# when one of the project's runs sits in Kiln's `unknown` phase (an ambiguous provider attempt keeps the
# project busy, so a new run would only queue behind it).
PREP = r'''
import json, os, sqlite3, subprocess, sys
service, want, name, db = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
def say(**kw):
    print(json.dumps(kw))
    raise SystemExit(0)
try:
    with open(os.path.expanduser(service)) as f:
        d = json.load(f)
except Exception as e:
    say(error="can't read Kiln's service profile %s (%s)" % (service, type(e).__name__))
ps = [p for p in d.get("projects") or [] if isinstance(p, dict) and p.get("id")]
pick = [p for p in ps if p.get("id") == want] if want else [
    p for p in ps if os.path.basename(str(p.get("repository_path") or "").rstrip("/")) == name]
if not pick:
    say(none=True, why=("Kiln has no project %s" % want) if want else ("Kiln has no project for %s" % name))
if len(pick) > 1:
    say(error="Kiln has several projects for %s: set onix.kiln.project" % name)
p = pick[0]
try:
    con = sqlite3.connect("file:" + os.path.expanduser(db) + "?mode=ro", uri=True)
    try:
        row = con.execute("select state from service_state").fetchone()
    finally:
        con.close()
    runs = (json.loads(row[0]) if row and row[0] else {}).get("runs") or {}
except Exception:
    runs = {}
for r in (runs.values() if isinstance(runs, dict) else runs):
    if isinstance(r, dict) and r.get("project_id") == p["id"] and r.get("phase") == "unknown":
        say(stuck=r.get("id"), project=p["id"], code=r.get("error_code"))
r = subprocess.run(["git", "-C", str(p.get("repository_path")), "rev-parse", "--verify", "--quiet",
                    str(p.get("reference")) + "^{commit}"], capture_output=True, text=True)
if r.returncode or not r.stdout.strip():
    say(error="Kiln's copy of %s has no %s" % (p["id"], p.get("reference")))
say(project=p["id"], reference=p.get("reference"), base=r.stdout.strip())
'''

# The task's changes (stdin: a binary diff from the base) as a Kiln run: {run, phase, base, files} or
# {moved: new base} (the branch moved since PREP) or {empty} or {error}.
SUBMIT = r'''
import json, os, shutil, subprocess, sys, tempfile
service, project, base, request, developer, identity = sys.argv[1:7]
diff = sys.stdin.buffer.read()
def say(**kw):
    print(json.dumps(kw))
    raise SystemExit(0)
with open(os.path.expanduser(service)) as f:
    d = json.load(f)
p = next((x for x in d.get("projects") or [] if isinstance(x, dict) and x.get("id") == project), None)
if not p:
    say(error="Kiln has no project %s" % project)
repo, ref = str(p.get("repository_path")), str(p.get("reference"))
tip = subprocess.run(["git", "-C", repo, "rev-parse", "--verify", "--quiet", ref + "^{commit}"],
                     capture_output=True, text=True).stdout.strip()
if tip != base:
    say(moved=tip or None)
dev = os.path.expanduser(developer)
if not identity:
    r = subprocess.run(["b3sum", "--no-names", dev], capture_output=True, text=True)
    identity = r.stdout.strip()
    if r.returncode or not identity:
        say(error="can't read Kiln's developer profile %s" % developer)
tmp = tempfile.mkdtemp(prefix="shepherdr-kiln-")
try:
    src = os.path.join(tmp, "src")
    def git(*a, **kw):
        return subprocess.run(["git", *a], stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kw)
    if git("clone", "--quiet", "--shared", "--no-checkout", repo, src).returncode:
        say(error="couldn't copy %s's repository for the check" % project)
    if git("-C", src, "checkout", "--quiet", "--detach", base).returncode:
        say(error="couldn't check out Kiln's base %s" % base[:7])
    r = git("-C", src, "apply", "--binary", "--whitespace=nowarn", "-", input=diff)
    if r.returncode:
        say(error="the task's changes don't apply to Kiln's %s at %s" % (ref, base[:7]))
    include, delete = [], []
    for e in git("-C", src, "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout.decode().split("\0"):
        if len(e) > 3:
            (delete if "D" in e[:2] else include).append(e[3:])
    if not include and not delete:
        say(empty=True)
    cmd = ["kiln-web-service", "ci", "--profile", dev, "--identity", identity, "submit", "--project", project,
           "--request-id", request, "--reference", ref, "--revision", base, "--dirty-repository", src]
    for x in include:
        cmd += ["--include", x]
    for x in delete:
        cmd += ["--delete", x]
    r = subprocess.run(cmd, capture_output=True, text=True)
    said = (r.stderr or r.stdout).strip().splitlines()
    if r.returncode:
        say(error="Kiln refused it: %s" % (said[-1][:300] if said else "exit %d" % r.returncode))
    try:
        run = json.loads(r.stdout)
    except ValueError:
        say(error="Kiln's answer wasn't a run")
    run = run.get("run") if isinstance(run.get("run"), dict) else run
    say(run=run.get("id") or run.get("run_id"), phase=run.get("phase"), base=base, files=len(include) + len(delete))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
'''

# One run's state, from Kiln's own (read-only, as kiln.py reads it): {phase, outcome, terminal} or {missing}.
RUN = r'''
import json, os, sqlite3, sys
run, db = sys.argv[1], os.path.expanduser(sys.argv[2])
try:
    con = sqlite3.connect("file:" + db + "?mode=ro", uri=True)
    try:
        row = con.execute("select state from service_state").fetchone()
    finally:
        con.close()
    runs = (json.loads(row[0]) if row and row[0] else {}).get("runs") or {}
except Exception as error:
    print(json.dumps({"error": str(error)[:200]}))
    raise SystemExit(0)
runs = runs.values() if isinstance(runs, dict) else runs
r = next((x for x in runs if isinstance(x, dict) and x.get("id") == run), None)
if r is None:
    print(json.dumps({"missing": True}))
else:
    obs = r.get("observation") if isinstance(r.get("observation"), dict) else {}
    print(json.dumps({"phase": r.get("phase"), "outcome": obs.get("outcome"), "terminal": obs.get("terminal") is True,
                      "project": r.get("project_id"), "code": r.get("error_code")}))
'''


def on_machine(machine, script, args, data=None, timeout=HC_TIMEOUT):
    """One script's JSON answer from Kiln's machine, or {"error": why}."""
    argv = ["hc", "exec", "--on", machine, "--timeout", str(timeout), *(["-i"] if data is not None else []),
            "--", "python3", "-c", script, *args]
    try:
        r = subprocess.run(argv, input=data, stdin=None if data is not None else subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout + 30)
    except subprocess.TimeoutExpired:
        return {"error": f"Kiln's machine took longer than {timeout}s"}
    except OSError as e:
        return {"error": f"couldn't run hc ({e.strerror or e})"}
    out = r.stdout.decode("utf-8", "replace").strip()
    if r.returncode != 0:
        said = (r.stderr.decode("utf-8", "replace") or out).strip()
        return {"error": said.splitlines()[-1][:200] if said else f"hc exec failed ({r.returncode})"}
    try:
        d = json.loads(out.splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": f"unreadable answer from {machine}"}
    return d if isinstance(d, dict) else {"error": "unreadable answer"}


# ---- settings -------------------------------------------------------------------------------------

def check_settings(s, space=None):
    """onix.kiln as this check reads it (the most specific layer wins), or None when the check is off."""
    out = {}
    for layer in settings_layers(s, space):
        onix = (layer or {}).get("onix") if isinstance(layer, dict) else None
        mine = onix.get("kiln") if isinstance(onix, dict) else None
        if isinstance(mine, dict):
            out.update({k: v for k, v in mine.items() if v is not None})
    text = lambda k, d="": out[k].strip() if isinstance(out.get(k), str) and out[k].strip() else d
    if out.get("before_merge") is not True or not text("machine"):
        return None
    identity = text("identity").lower()
    return {"machine": text("machine"), "project": text("project"), "service": text("service", DEFAULT_SERVICE),
            "developer": text("developer", DEFAULT_DEVELOPER), "identity": identity if B3.match(identity) else "",
            "db": text("db", DEFAULT_DB)}


def enabled(s, t):
    """The check's settings when this task's merge waits on it: an Onix repo's worktree task, the check on."""
    from . import onix  # onix.py's import of this module comes first
    if not (t.get("mode") == "worktree" and t.get("branch") and onix.mode(s, t.get("space"))):
        return None
    return check_settings(s, t.get("space"))


# ---- the task's record ----------------------------------------------------------------------------

def head_of(s, t):
    ok, sha, _ = git(s.loc["folder"], "rev-parse", "--verify", "--quiet", f"refs/heads/{t.get('branch')}")
    return (sha if ok and sha else None) or t.get("head")


def want(s, t):
    """The task's head is to be checked: a pending record for it unless it has one. The record, or None (off)."""
    cfg = enabled(s, t)
    head = head_of(s, t) if cfg else None
    if not head:
        return None
    rec = t.get("kiln_check") if isinstance(t.get("kiln_check"), dict) else None
    if rec and rec.get("head") == head:
        return rec
    t["kiln_check"] = {"head": head, "outcome": "pending", "phase": "to send", "at": now()}
    s.dirty = True
    return t["kiln_check"]


def request_id(s, t, head):
    """Kiln's idempotency key for this task's check of this head (letters, digits, - _ . only)."""
    key = re.sub(r"[^A-Za-z0-9_.-]+", "-", s.key(t)).strip("-")[-60:]
    return f"shepherdr-{key}-{head[:12]}"


def submit(s, t, cfg, rec):
    """Sends the task's changes to Kiln: the record's next state (run asked for, or why not)."""
    main, head = s.loc["folder"], rec["head"]
    name = os.path.basename(os.path.normpath(main))
    prep = on_machine(cfg["machine"], PREP, [cfg["service"], cfg["project"], name, cfg["db"]])
    if prep.get("none"):
        return {**rec, "outcome": "none", "phase": "", "why": prep.get("why"), "at": now()}
    if prep.get("stuck"):
        return {**rec, "outcome": "unknown", "project": prep.get("project"), "at": now(),
                "why": f"Kiln's {prep.get('project')} is held by run {prep['stuck']}, unknown ({prep.get('code') or 'no answer'}): "
                       "Kiln dispatches nothing more for it until that run is reconciled there"}
    if prep.get("error"):
        return {**rec, "outcome": "unknown", "why": prep["error"], "at": now()}
    for _ in range(2):  # the branch may move between the two calls: once more from its new tip
        base = prep["base"]
        if not git(main, "cat-file", "-e", f"{base}^{{commit}}")[0]:
            git(main, "fetch", "--quiet", "origin")
        if not git(main, "cat-file", "-e", f"{base}^{{commit}}")[0]:
            return {**rec, "outcome": "unknown", "project": prep["project"], "base": base, "at": now(),
                    "why": f"Kiln's {prep['project']} {prep.get('reference')} ({base[:7]}) isn't in this repo: push it, or fetch it here"}
        r = subprocess.run(["git", "-C", main, "diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", base, head],
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if r.returncode:
            return {**rec, "outcome": "unknown", "at": now(), "why": f"couldn't diff {head[:7]} from Kiln's base {base[:7]}"}
        if len(r.stdout) > MAX_DIFF:
            return {**rec, "outcome": "unknown", "at": now(), "why": f"its changes are over {MAX_DIFF // 1048576} MiB: too big to send"}
        got = on_machine(cfg["machine"], SUBMIT, [cfg["service"], prep["project"], base, request_id(s, t, head),
                                                   cfg["developer"], cfg["identity"]], data=r.stdout)
        if "moved" in got and got.get("moved"):
            prep = {**prep, "base": got["moved"]}
            continue
        break
    common = {"project": prep["project"], "base": prep["base"], "at": now()}
    if got.get("empty"):
        return {**rec, **common, "outcome": "none", "phase": "", "why": "nothing to check: no changes beyond Kiln's base"}
    if got.get("error") or not got.get("run"):
        return {**rec, **common, "outcome": "unknown", "why": got.get("error") or "Kiln named no run"}
    return {**rec, **common, "run": str(got["run"]), "phase": str(got.get("phase") or "queued"), "outcome": "pending",
            "asked": now()}


def judge(answer):
    """pending | success | failure | unknown for one run's state (kiln.py's rule: only a terminal run with
    an outcome of its own answers; anything but Success fails)."""
    from .kiln import judge as kiln_judge
    return kiln_judge({"phase": answer.get("phase"), "outcome": answer.get("outcome"), "terminal": answer.get("terminal")})


def follow(cfg, rec):
    """The record after asking Kiln about its run once."""
    got = on_machine(cfg["machine"], RUN, [rec["run"], cfg["db"]], timeout=90)
    if got.get("error") or got.get("missing"):
        return {**rec, "seen": now(), **({"note": got["error"]} if got.get("error") else {})}
    if got.get("phase") == "unknown":
        # Kiln's provider gave an ambiguous answer (its error code says which): no verdict will come
        # for this run without an operator's reconcile there, so it holds nothing here.
        return {**rec, "seen": now(), "phase": "unknown", "outcome": "unknown",
                "why": f"{rec['project']} run {rec['run']} is unknown in Kiln ({got.get('code') or 'no answer from its provider'})"}
    outcome = judge(got)
    raw = str(got.get("outcome") or "")
    return {**rec, "seen": now(), "phase": str(got.get("phase") or ""), "outcome": outcome,
            **({"why": f"{rec['project']} run {rec['run']} ended {raw}"} if outcome == "failure" else
               {"why": f"{rec['project']} run {rec['run']} ended without an answer"} if outcome == "unknown" else {})}


# ---- what it says, and what a merge does with it -------------------------------------------------

def words(rec):
    """The Accept card's Checks row for it: {state, text}."""
    o, where = rec.get("outcome"), " ".join(x for x in (rec.get("project"), f"run {rec['run']}" if rec.get("run") else "") if x)
    if o == "success":
        return {"state": "passed", "text": f"Kiln passed: {where}"}
    if o == "failure":
        return {"state": "failed", "text": f"Kiln failed: {rec.get('why') or where}"}
    if o == "pending":
        return {"state": "running", "text": f"Kiln is checking it: {where}" if rec.get("run") else "Kiln checks it next"}
    if o == "none":
        return {"state": "none", "text": f"No Kiln check: {rec.get('why') or 'no project for this repo'}"}
    return {"state": "unknown", "text": f"Kiln unknown: {rec.get('why') or 'no answer'}"}


KILN_RUNNING = "Kiln is checking it"


def hold(s, t):
    """Whether Kiln holds the task's merge now: None (go), else (why, waiting). Waiting: a run for its
    head is pending (it merges once Kiln passes). Not waiting: Kiln failed it."""
    rec = want(s, t)
    if not rec:
        return None
    if rec.get("outcome") == "failure":
        return f"Kiln failed: {rec.get('why') or rec.get('project') or ''}".rstrip(": "), False
    if rec.get("outcome") == "pending":
        where = f" ({rec['project']} run {rec['run']})" if rec.get("run") else ""
        return f"{KILN_RUNNING}{where}: it merges once Kiln passes.", True
    return None


def check_pass(s, report, merge_now):
    """One scheduler round for a folder's Ready tasks: sends a pending check, follows a run (at most every
    EVERY_MS), and when Kiln has answered: a failure goes to Needs you, a pass merges a task whose merge
    waited on it (merge_now: commands.onix_merge_now)."""
    for t in [t for t in s.data.get("tasks") or [] if t.get("state") == "ready"]:
        rec = want(s, t)
        if not rec or rec.get("outcome") in SETTLED and rec.get("outcome") != "success":
            continue
        cfg = enabled(s, t)
        if rec.get("outcome") == "pending":
            if not rec.get("run"):
                if now() - (rec.get("tried") or 0) < EVERY_MS:
                    continue
                key = s.key(t)
                with released(s):
                    nxt = submit(s, t, cfg, {**rec, "tried": now()})
                t = next((x for x in s.data.get("tasks") or [] if s.key(x) == key), None)
                if not t or (t.get("kiln_check") or {}).get("head") != nxt["head"] or t.get("state") != "ready":
                    continue  # it moved on meanwhile
            elif now() - (rec.get("asked") or rec.get("at") or 0) >= WINDOW_MS:
                nxt = {**rec, "outcome": "unknown", "why": f"{rec.get('project')} run {rec.get('run')} gave no answer in 2 h"}
            elif now() - (rec.get("seen") or 0) < EVERY_MS:
                continue
            else:
                nxt = follow(cfg, rec)
            t["kiln_check"] = nxt
            s.dirty = True
            rec = nxt
            if rec["outcome"] == "failure":
                t["attention"], t["attention_at"] = f"Kiln failed: {rec.get('why')}", now()
                report.setdefault("attention", []).append(t["id"])
        if rec.get("outcome") in ("success", "unknown", "none") and t.get("auto_merge") and not t.get("attention"):
            if not merge_now(s, t):
                report.setdefault("done", []).append(t["id"])


def released(s):
    from .github import released as let_go  # the task list's lock let go around slow work (#1007)
    return let_go(s)
