"""Kiln (kiln.py): the read-only reader of Kiln's own service state, and the scheduler's pass that
asks it about a merged Onix commit.

The reader runs on a synthetic service.sqlite (the success, failure, pending, no-run and malformed
cases). The pass runs with a throwaway task store, a throwaway settings file and a fake `hc` on PATH
that runs the reader where `hc exec --on <machine>` would: throttle, the 2 h give-up, task news told
once, and nothing at all while onix.kiln.machine is unset.
"""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "mods", "tasks", "bin")
sys.dont_write_bytecode = True
sys.path.insert(0, BIN)
from herdr_task import base, kiln, launch, news, settings, store  # noqa: E402

SHA = "0c56456214196618bba512990ac479e69ebd7b63"
OTHER = "15e72b5a330b08139ac7c809ac31e7e87f825b22"

# A fake hc: `exec` runs what it was given (the reader, on the db), every call is logged. Any other
# subcommand answers nothing (exit 1), as a test's assistant is told by a patched news_send.
FAKE_HC = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
args = sys.argv[1:]
with open(os.environ["KILN_HC_LOG"], "a") as f:
    f.write(json.dumps(args) + "\n")
if args[:1] == ["exec"]:
    if os.environ.get("KILN_HC_FAIL"):
        sys.stderr.write("no such machine\n")
        sys.exit(1)
    rest = args[args.index("--") + 1:] if "--" in args else []
    run = [sys.executable, *rest[1:]] if rest[:1] == ["python3"] else rest
    done = subprocess.run(run, capture_output=True, text=True)
    sys.stdout.write(done.stdout)
    sys.stderr.write(done.stderr)
    sys.exit(done.returncode)
sys.exit(1)
'''


def run_of(sha=SHA, outcome="Success", phase="terminal", terminal=True, project="kiln-self-ci",
           run="web-run-1", ordinal=1):
    """One of Kiln's runs, as service_state holds it (source.exact_revision.native_id, observation)."""
    return {"id": run, "ordinal": ordinal, "project_id": project, "phase": phase,
            "source": {"exact_revision": {"native_id": sha}},
            "observation": {"outcome": outcome, "terminal": terminal, "state": "Completed"}}


def journal(path, runs, state=None):
    con = sqlite3.connect(path)
    try:
        con.execute("create table service_state (state text)")
        stored = state if state is not None else {"version": 2, "runs": {r["id"]: r for r in runs}}
        con.execute("insert into service_state values (?)", (json.dumps(stored),))
        con.commit()
    finally:
        con.close()


class Reader(unittest.TestCase):
    """The reader alone: Kiln's state read-only, only the runs of one exact revision."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="kiln-reader-")

    def read(self, sha, db):
        p = subprocess.run([sys.executable, "-c", kiln.READER, sha, db], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def test_success(self):
        db = os.path.join(self.dir, "ok.sqlite")
        journal(db, [run_of(), run_of(sha=OTHER, run="web-run-2", ordinal=2)])
        got = self.read(SHA, db)
        self.assertEqual([(r["run"], r["project"], r["phase"], r["outcome"], r["terminal"], r["rev"]) for r in got["runs"]],
                         [("web-run-1", "kiln-self-ci", "terminal", "Success", True, SHA)])
        self.assertEqual(kiln.judge(got["runs"][0]), "success")

    def test_failure(self):
        db = os.path.join(self.dir, "bad.sqlite")
        journal(db, [run_of(outcome="DomainFailure")])
        got = self.read(SHA, db)
        self.assertEqual(got["runs"][0]["outcome"], "DomainFailure")
        self.assertEqual(kiln.judge(got["runs"][0]), "failure")

    def test_pending(self):
        db = os.path.join(self.dir, "pending.sqlite")
        journal(db, [run_of(outcome="", phase="running", terminal=False)])
        got = self.read(SHA, db)
        self.assertEqual(got["runs"][0]["phase"], "running")
        self.assertFalse(got["runs"][0]["terminal"])
        self.assertEqual(kiln.judge(got["runs"][0]), "pending")

    def test_no_matching_run(self):
        db = os.path.join(self.dir, "other.sqlite")
        journal(db, [run_of(sha=OTHER)])
        self.assertEqual(self.read(SHA, db), {"runs": []})

    def test_malformed_state(self):
        db = os.path.join(self.dir, "junk.sqlite")
        journal(db, [], state=None)
        con = sqlite3.connect(db)
        try:
            con.execute("update service_state set state = ?", ("not json",))
            con.commit()
        finally:
            con.close()
        got = self.read(SHA, db)
        self.assertIn("error", got)
        self.assertNotIn("runs", got)

    def test_missing_fields(self):
        """What an older or newer Kiln leaves out: the run is still found, its gaps read as nothing."""
        db = os.path.join(self.dir, "sparse.sqlite")
        journal(db, [], state={"runs": [{"id": "web-run-9", "source": {"exact_revision": {"native_id": SHA}}}]})
        got = self.read(SHA, db)
        self.assertEqual([(r["run"], r["project"], r["phase"], r["outcome"], r["terminal"]) for r in got["runs"]],
                         [("web-run-9", "", "", "", False)])
        self.assertEqual(kiln.judge(got["runs"][0]), "pending")

    def test_read_only(self):
        """A db that isn't there is not made: the read can't write (`mode=ro`)."""
        db = os.path.join(self.dir, "absent.sqlite")
        got = self.read(SHA, db)
        self.assertIn("error", got)
        self.assertFalse(os.path.exists(db))

    def test_terminal_flag_carries_the_phase(self):
        """A run without observation.terminal but at phase terminal is still settled."""
        self.assertEqual(kiln.judge({"phase": "terminal", "outcome": "Success", "terminal": False}), "success")
        self.assertEqual(kiln.judge({"phase": "Terminal", "outcome": "", "terminal": False}), "unknown")
        self.assertEqual(kiln.judge({"phase": "queued", "outcome": "Success", "terminal": False}), "pending")


class Pass(unittest.TestCase):
    """The scheduler's pass: a throwaway task store and settings, a fake hc on PATH, a fake clock."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="kiln-pass-")
        self.folder = os.path.join(self.dir, "repo")
        os.makedirs(self.folder)
        self.tasks = os.path.join(self.dir, "tasks")
        os.makedirs(self.tasks)
        self.settings_file = os.path.join(self.dir, "settings.json")
        self.db = os.path.join(self.dir, "service.sqlite")
        self.log = os.path.join(self.dir, "hc.log")
        self.hc_dir = os.path.join(self.dir, "bin")
        os.makedirs(self.hc_dir)
        hc = os.path.join(self.hc_dir, "hc")
        with open(hc, "w") as f:
            f.write(FAKE_HC)
        os.chmod(hc, 0o755)
        self.t = [base.now()]
        self.sent = []
        self.can_take = True

        def deliver(address, text):
            self.sent.append((address, text))
            return self.can_take

        patches = [mock.patch.object(store, "STORE", self.tasks),
                   mock.patch.object(kiln, "STATE", os.path.join(self.dir, "kiln.json")),
                   mock.patch.object(settings, "SETTINGS", self.settings_file),
                   mock.patch.object(base, "not_real", lambda: None),
                   mock.patch.object(kiln, "now", lambda: self.t[0]),
                   mock.patch.object(launch, "coordinator_in", lambda space: "assistant-1" if space else None),
                   mock.patch.object(news, "news_send", deliver)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.env = {"KILN_HC_LOG": self.log}
        for k, v in self.env.items():
            old = os.environ.get(k)
            os.environ[k] = v
            self.addCleanup(lambda k=k, old=old: os.environ.pop(k, None) if old is None else os.environ.__setitem__(k, old))
        old_path = os.environ.get("PATH") or ""
        os.environ["PATH"] = self.hc_dir + os.pathsep + old_path
        self.addCleanup(lambda: os.environ.__setitem__("PATH", old_path))

    # ---- the pieces a test drives ------------------------------------------------------------
    def settings_with(self, machine="ci-host", db=None):
        kiln_cfg = {"db": db or self.db}
        if machine:
            kiln_cfg["machine"] = machine
        with open(self.settings_file, "w") as f:
            json.dump({"everywhere": {"onix": {"kiln": kiln_cfg}}}, f)

    def add(self, sha=SHA, at=None, title="Fix the thing", space="sp1"):
        with store.Store(store.locate(self.folder)) as s:
            t = s.new(title)
            t.update(state="done", space=space, onix_merge={"sha": sha, "base": "main", "at": self.t[0] if at is None else at})
            s.dirty = True

    def round(self):
        report = {}
        with store.Store(store.locate(self.folder)) as s:
            kiln.kiln_pass(s, report)
        return report

    def tell(self):
        report = {}
        kiln.kiln_tell(report)
        return report

    def task(self, n=1):
        d = store.read_list(store.store_path(self.folder)[1])
        return next(t for t in d["tasks"] if t["id"] == n)

    def calls(self):
        try:
            with open(self.log) as f:
                return [json.loads(line) for line in f if line.strip()]
        except OSError:
            return []

    def execs(self):
        return [c for c in self.calls() if c[:1] == ["exec"]]

    def advance(self, ms):
        self.t[0] += ms

    # ---- what it does ------------------------------------------------------------------------
    def test_success_is_recorded_and_told_once(self):
        self.settings_with()
        journal(self.db, [run_of()])
        self.add()
        self.round()
        rec = self.task()["kiln"]
        self.assertEqual({k: rec[k] for k in ("project", "run", "phase", "outcome")},
                         {"project": "kiln-self-ci", "run": "web-run-1", "phase": "terminal", "outcome": "success"})
        self.assertEqual(self.sent, [])
        self.tell()
        self.assertEqual(len(self.sent), 1)
        address, text = self.sent[0]
        self.assertEqual(address, "assistant-1")
        self.assertIn('event="kiln"', text)
        self.assertIn("passed", text)
        self.assertIn(SHA[:7], text)
        # Settled: no more reads, and the same word isn't told twice.
        self.advance(2 * 60 * 1000)
        self.round()
        self.tell()
        self.assertEqual(len(self.execs()), 1)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.task()["kiln"]["outcome"], "success")

    def test_failure_says_failed(self):
        self.settings_with()
        journal(self.db, [run_of(outcome="DomainFailure")])
        self.add()
        self.round()
        self.assertEqual(self.task()["kiln"]["outcome"], "failure")
        self.tell()
        self.assertIn("failed", self.sent[0][1])
        self.assertIn("DomainFailure", self.sent[0][1])

    def test_pending_is_recorded_and_asks_at_most_every_two_minutes(self):
        self.settings_with()
        journal(self.db, [run_of(outcome="", phase="running", terminal=False)])
        self.add()
        self.round()
        self.assertEqual(self.task()["kiln"]["outcome"], "pending")
        self.assertEqual(len(self.execs()), 1)
        self.assertEqual(self.sent, [])
        self.advance(60 * 1000)          # a minute on: still too soon
        self.round()
        self.assertEqual(len(self.execs()), 1)
        self.advance(60 * 1000)          # two: it asks again
        self.round()
        self.assertEqual(len(self.execs()), 2)
        # Kiln finished the run in between: the settled word goes out.
        os.remove(self.db)
        journal(self.db, [run_of()])
        self.advance(2 * 60 * 1000)
        self.round()
        self.tell()
        self.assertEqual(self.task()["kiln"]["outcome"], "success")
        self.assertEqual(len(self.sent), 1)

    def test_no_run_yet_is_neither_recorded_nor_passed(self):
        self.settings_with()
        journal(self.db, [run_of(sha=OTHER)])
        self.add()
        self.round()
        self.assertNotIn("kiln", self.task())
        self.assertEqual(len(self.execs()), 1)
        self.assertEqual(self.sent, [])

    def test_two_hours_without_a_run_is_unknown(self):
        self.settings_with()
        journal(self.db, [run_of(sha=OTHER)])
        self.add()
        self.round()
        self.assertEqual(len(self.execs()), 1)
        self.advance(2 * 3600 * 1000)
        self.round()
        self.assertEqual(len(self.execs()), 1, "the give-up needs no machine call")
        rec = self.task()["kiln"]
        self.assertEqual(rec["outcome"], "unknown")
        self.assertEqual((rec["project"], rec["run"]), ("", ""))
        self.tell()
        self.assertEqual(len(self.sent), 1)
        self.assertIn("no run", self.sent[0][1])
        self.assertIn("unknown", self.sent[0][1])
        self.assertNotIn("passed", self.sent[0][1])
        # Settled as unknown: nothing more is asked or told.
        self.advance(10 * 60 * 1000)
        self.round()
        self.tell()
        self.assertEqual(len(self.execs()), 1)
        self.assertEqual(len(self.sent), 1)

    def test_off_while_the_machine_is_unset(self):
        self.settings_with(machine=None)
        journal(self.db, [run_of()])
        self.add()
        self.round()
        self.tell()
        self.assertEqual(self.calls(), [])
        self.assertNotIn("kiln", self.task())
        self.assertEqual(self.sent, [])

    def test_one_read_for_a_shared_sha(self):
        self.settings_with()
        journal(self.db, [run_of()])
        self.add(title="First")
        self.add(title="Second")
        self.round()
        self.assertEqual(len(self.execs()), 1)
        self.assertEqual([t["kiln"]["outcome"] for t in store.read_list(store.store_path(self.folder)[1])["tasks"]],
                         ["success", "success"])
        self.assertIn(["--on", "ci-host"], [c[1:3] for c in self.execs()])
        self.assertIn(self.db, self.execs()[0])
        self.assertIn(SHA, self.execs()[0])

    def test_a_failed_read_writes_nothing(self):
        self.settings_with()
        os.environ["KILN_HC_FAIL"] = "1"
        self.addCleanup(os.environ.pop, "KILN_HC_FAIL", None)
        self.add()
        self.round()
        self.assertEqual(len(self.execs()), 1)
        self.assertNotIn("kiln", self.task())
        self.tell()
        self.assertEqual(self.sent, [])

    def test_a_busy_assistant_gets_the_line_later(self):
        self.settings_with()
        journal(self.db, [run_of()])
        self.add()
        self.round()
        self.can_take = False
        self.tell()
        self.assertEqual(len(self.sent), 1, "it tried")  # the Assistant couldn't take it
        self.sent.clear()
        self.can_take = True
        self.tell()
        self.assertEqual(len(self.sent), 1)
        self.assertIn("passed", self.sent[0][1])
        self.tell()
        self.assertEqual(len(self.sent), 1, "told once")


if __name__ == "__main__":
    unittest.main()
