"""Kiln: whether CI passed for the commit an Onix repo's task merged (post-merge, read-only).

An Onix repo merges into its base with no pull request, so GitHub's checks have nothing to say about
the result: Kiln, the exact-revision CI service, does. After that merge (the task's `onix_merge`,
written by the merge path: {sha, base, at}) the scheduler asks Kiln's own state, on the machine that
runs it, for a run whose source exact revision is that sha: at most every 2 minutes, for up to 2 hours
after the merge.

Settings (Shepherdr settings' `onix` object, Everywhere's or this machine's or the space's):
  onix.kiln.machine  the hc machine Kiln runs on; unset: off (nothing is read, nothing is written)
  onix.kiln.db       Kiln's service state (default ~/git/.kiln-web-service/web-live/service.sqlite)

The read is one SQLite open in read-only mode (`file:<path>?mode=ro`, `select state from
service_state`) through `hc exec --on <machine>`, the same read the person's Kiln panel makes: nothing
is started, and Lattice (Kiln's executor) is never talked to.

What it keeps on the task is `kiln`: {project, run, phase, outcome, at} with outcome
pending | success | failure | unknown. A settled run is told to the space's Assistant (once, as task
news); a merge with no run for 2 hours is `unknown` - no run is never "passed".
"""

import json
import os
import subprocess
import time

from .base import beside_store, guard, now
from .settings import bare, settings_layers


EVERY_MS = 2 * 60 * 1000             # ask Kiln at most this often per merged commit
WINDOW_MS = 2 * 3600 * 1000          # for up to this long after the merge
KEEP_MS = 6 * 3600 * 1000            # a line no Assistant could be told this long: dropped
SLACK_MS = 15 * 60 * 1000            # the give-up is still written this long past the window (a sleeping machine)
DEFAULT_DB = "~/git/.kiln-web-service/web-live/service.sqlite"
TERMINAL = ("success", "failure", "unknown")
STATE = beside_store("cli-check", "kiln.json")   # the state folder: checks' clock, what was told
FIELDS = ("project", "run", "phase", "outcome")


# ---- Kiln's state, read on the machine that runs it ----------------------------------------------
# Kiln keeps every run in one JSON row (`service_state`): `state.runs` is {run id: run}, each run
# {id, project_id, phase, source.exact_revision.native_id, observation{outcome, terminal, state}, ...}.
# Reads only what answers "which runs built this commit", and tolerates what an older or newer Kiln
# leaves out.
READER = r'''
import json, os, sqlite3, sys

def text(x):
    return x if isinstance(x, str) else ""

sha = text(sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()
db = os.path.expanduser(text(sys.argv[2] if len(sys.argv) > 2 else "") or "~/git/.kiln-web-service/web-live/service.sqlite")
try:
    con = sqlite3.connect("file:" + db + "?mode=ro", uri=True)
    try:
        row = con.execute("select state from service_state").fetchone()
    finally:
        con.close()
    stored = json.loads(row[0]) if row and row[0] else {}
except Exception as error:
    print(json.dumps({"error": str(error)[:200]}))
    raise SystemExit(0)
runs = stored.get("runs") if isinstance(stored, dict) else None
if isinstance(runs, dict):
    runs = list(runs.values())
if not isinstance(runs, list):
    runs = []
found = []
for run in runs:
    if not isinstance(run, dict):
        continue
    source = run.get("source") if isinstance(run.get("source"), dict) else {}
    exact = source.get("exact_revision") if isinstance(source.get("exact_revision"), dict) else {}
    rev = text(exact.get("native_id")).strip().lower()
    if not rev or rev != sha:
        continue
    obs = run.get("observation") if isinstance(run.get("observation"), dict) else {}
    ordinal, done = run.get("ordinal"), run.get("completed_at_ms")
    found.append({"run": text(run.get("id")), "project": text(run.get("project_id")),
                  "phase": text(run.get("phase")), "outcome": text(obs.get("outcome")),
                  "terminal": obs.get("terminal") is True, "rev": rev,
                  "ordinal": ordinal if isinstance(ordinal, int) else 0,
                  "completed": done if isinstance(done, int) else 0})
found.sort(key=lambda r: (r["ordinal"], r["completed"]), reverse=True)
print(json.dumps({"runs": found}))
'''


def read_runs(machine, sha, db, timeout=90):
    """Kiln's runs for this exact revision, read on `machine`: (runs, why not)."""
    guard(["hc"])
    try:
        r = subprocess.run(["hc", "exec", "--on", machine, "--timeout", str(timeout), "--",
                            "python3", "-c", READER, sha, db],
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=timeout + 30)
    except subprocess.TimeoutExpired:
        return None, "timed out"
    except OSError as error:
        return None, str(error)[:200]
    if r.returncode != 0:
        return None, (r.stderr or r.stdout).strip()[-200:] or f"hc exec failed ({r.returncode})"
    try:
        answer = json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return None, f"unreadable answer: {r.stdout.strip()[-200:]}"
    if not isinstance(answer, dict):
        return None, "unreadable answer"
    if answer.get("error"):
        return None, str(answer["error"])[:200]
    runs = answer.get("runs")
    return (runs if isinstance(runs, list) else []), None


# ---- what the runs say --------------------------------------------------------------------------

def judge(run):
    """pending | success | failure | unknown for one run: only a terminal phase with an outcome of
    its own is an answer, and anything but Success is a failure (Kiln's DomainFailure and the rest)."""
    phase = str(run.get("phase") or "").strip().lower()
    outcome = str(run.get("outcome") or "").strip().lower()
    if not (run.get("terminal") is True or phase == "terminal"):
        return "pending"
    if outcome == "success":
        return "success"
    if outcome in ("", "unknown"):
        return "unknown"
    return "failure"


def pick(runs, sha):
    """The run to believe for this sha: the newest one (a retry is a new run), or None."""
    for run in runs:
        if not isinstance(run, dict):
            continue
        rev = str(run.get("rev") or "").strip().lower()
        if rev and rev != sha:
            continue
        return run
    return None


# ---- settings -----------------------------------------------------------------------------------

def kiln_settings(s, space=None):
    """Kiln's settings for a folder's tasks: `onix.kiln` of Everywhere's, this machine's, then the
    space's (the most specific wins): {machine, db}. machine None: the whole thing is off."""
    out = {}
    for layer in settings_layers(s, space):
        onix = (layer or {}).get("onix") if isinstance(layer, dict) else None
        mine = onix.get("kiln") if isinstance(onix, dict) else None
        if isinstance(mine, dict):
            out.update({k: v for k, v in mine.items() if v is not None})
    machine = out.get("machine")
    machine = machine.strip() if isinstance(machine, str) and machine.strip() else None
    db = out.get("db")
    db = db.strip() if isinstance(db, str) and db.strip() else DEFAULT_DB
    return {"machine": machine, "db": db}


# ---- its own file (the checks' clock, what was told, the lines not sent yet) --------------------

def read_state():
    try:
        with open(STATE) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(d, dict):
        return {}
    for kind in ("checks", "told"):
        if not isinstance(d.get(kind), dict):
            d.pop(kind, None)
    if not isinstance(d.get("outbox"), list):
        d.pop("outbox", None)
    return d


def save_state(state):
    os.makedirs(os.path.dirname(STATE) or ".", exist_ok=True)
    tmp = f"{STATE}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, STATE)


# ---- the task's record and its news -------------------------------------------------------------

def waiting(task):
    """Whether this task's merge still waits on Kiln: `onix_merge` and no settled `kiln` outcome."""
    merge = task.get("onix_merge")
    if not isinstance(merge, dict) or not merge.get("sha"):
        return False
    if (task.get("kiln") or {}).get("outcome") in TERMINAL:
        return False
    at = merge.get("at")
    return now() - at < WINDOW_MS + SLACK_MS if isinstance(at, (int, float)) else True


def remember(s, t, rec):
    """Keeps one observation on the task, a change only (a pending run's record isn't rewritten every
    2 minutes while it says the same). True when the task changed."""
    old = t.get("kiln") if isinstance(t.get("kiln"), dict) else None
    if old is not None and all(old.get(k) == rec.get(k) for k in FIELDS):
        return False
    t["kiln"] = rec
    if s.write:
        s.dirty = True
    return True


def news_line(ref, text):
    """Task news as the chat shows it: one line, tagged with the task and what it is."""
    attr = str(ref).replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")
    return f'<herdr-news task="{attr}" event="kiln">{text.replace("<", "‹").replace(">", "›")}</herdr-news>'


def outcome_line(ref, sha, run, outcome, give_up=False):
    """What the space's Assistant is told: the merged commit's sha, Kiln's project and run, and why
    it failed when it did."""
    short = (sha or "")[:7]
    project = str((run or {}).get("project") or "Kiln")
    name = str((run or {}).get("run") or "")
    where = f"{project} run {name}" if name else project
    if outcome == "success":
        return news_line(ref, f"{ref} merged and Kiln passed: {where} for {short}")
    if outcome == "failure":
        raw = str((run or {}).get("outcome") or "").strip()
        return news_line(ref, f"{ref} merged but Kiln failed: {where} for {short}" + (f": {raw}" if raw else ""))
    if give_up and run is None:
        return news_line(ref, f"{ref} merged but Kiln has no run for {short} after 2 h: outcome unknown")
    if give_up:
        return news_line(ref, f"{ref} merged but Kiln hasn't settled {where} for {short} after 2 h: outcome unknown")
    return news_line(ref, f"{ref} merged and Kiln's run for {short} ended unknown: {where}")


def queue(state, s, t, text):
    """A line for the space's Assistant, kept until it can take it (a newer word on the same task
    replaces one not sent yet)."""
    outbox = state.setdefault("outbox", [])
    key = s.key(t)
    outbox[:] = [x for x in outbox if x.get("key") != key]
    outbox.append({"key": key, "space": bare(t.get("space")), "folder": os.path.basename(s.loc["folder"]),
                   "text": text, "at": now()})


def tell(state, report, coordinator_in, news_send):
    """Sends the lines that waited, one message per space's Assistant; the ones it can't take now
    (it is being written to, or it isn't running) wait for the next round. True when anything moved."""
    outbox = state.setdefault("outbox", [])
    before = len(outbox)
    outbox[:] = [x for x in outbox if now() - (x.get("at") or 0) < KEEP_MS]
    moved = len(outbox) != before
    for space in list(dict.fromkeys(x.get("space") for x in outbox)):
        batch = [x for x in outbox if x.get("space") == space]
        to = coordinator_in(space) if space else None
        if not to or not news_send(to, "\n".join(x["text"] for x in batch)):
            continue
        outbox[:] = [x for x in outbox if x not in batch]
        moved = True
        report.setdefault("news", []).append({"to": to, "lines": [x["text"] for x in batch]})
        try:  # kept for the lead machine's home Assistant, as news_pass keeps its own
            from .home import log_news
            log_news([{"at": now(), "space": space, "folder": batch[0].get("folder"), "to": to,
                       "lines": [x["text"] for x in batch]}])
        except Exception:  # never stops the news
            pass
    return moved


# ---- the scheduler's pass -----------------------------------------------------------------------

def kiln_pass(s, report):
    """One round for a folder: asks Kiln about each merged commit still waiting (throttled), keeps
    what it says on the task, and tells the space's Assistant a settled outcome once. Off while
    `onix.kiln.machine` is unset: nothing is asked and nothing is written on the tasks."""
    state = read_state()
    checks, told = state.setdefault("checks", {}), state.setdefault("told", {})
    tasks = s.data.get("tasks") or []
    live = {s.key(t) for t in tasks}
    moved = False
    for kind in (checks, told):  # a task that left the list leaves no trace
        for k in [k for k in kind if k not in live]:
            kind.pop(k, None)
            moved = True
    calls = {}
    for t in [t for t in tasks if waiting(t)]:
        cfg = kiln_settings(s, t.get("space"))
        if not cfg["machine"]:
            continue
        merge = t.get("onix_merge") or {}
        sha = str(merge.get("sha") or "").strip().lower()
        if not sha:
            continue
        key = s.key(t)
        at = merge.get("at")
        if isinstance(at, (int, float)) and now() - at >= WINDOW_MS:
            # Two hours and no run to believe: unknown, never passed.
            old = t.get("kiln") if isinstance(t.get("kiln"), dict) else {}
            rec = {"project": old.get("project") or "", "run": old.get("run") or "",
                   "phase": old.get("phase") or "", "outcome": "unknown", "at": now()}
            moved = remember(s, t, rec) or moved
            checks.pop(key, None)
            if told.get(key) != "unknown":
                told[key] = "unknown"
                moved = True
                seen = old if old.get("run") else None
                queue(state, s, t, outcome_line(s.ref(t), sha, seen, "unknown", give_up=True))
            continue
        if now() - (checks.get(key) or 0) < EVERY_MS:
            continue
        checks[key] = now()
        moved = True
        calls.setdefault((cfg["machine"], cfg["db"], sha), []).append(t)
    for (machine, db, sha), group in calls.items():
        runs, why = read_runs(machine, sha, db)
        if runs is None:
            print(f"{time.strftime('%H:%M:%S')} kiln: {machine}: {why}", flush=True)
            continue
        run = pick(runs, sha)
        if run is None:
            continue  # no run yet: nothing is recorded for that (the 2 h give-up writes unknown)
        outcome = judge(run)
        for t in group:
            key = s.key(t)
            rec = {"project": str(run.get("project") or ""), "run": str(run.get("run") or ""),
                   "phase": str(run.get("phase") or ""), "outcome": outcome, "at": now()}
            moved = remember(s, t, rec) or moved
            if outcome not in TERMINAL:
                continue
            checks.pop(key, None)
            if told.get(key) != outcome:
                told[key] = outcome
                moved = True
                queue(state, s, t, outcome_line(s.ref(t), sha, run, outcome))
    if moved:
        save_state(state)


def kiln_tell(report):
    """Sends the task news kiln_pass queued, once a round: a folder whose merge is settled isn't
    looked at any more (it isn't busy), so the line can't be sent from its own pass."""
    from .launch import coordinator_in
    from .news import news_send
    state = read_state()
    if not state.get("outbox"):
        return
    if tell(state, report, coordinator_in, news_send):
        save_state(state)
