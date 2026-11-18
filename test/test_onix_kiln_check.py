"""onix: Kiln checks a task before it merges (herdr_task/kiln_check.py).

Real throwaway repos (test_onix_forge's OnixRepo), a throwaway "Kiln machine": its service profile, its
own copy of the project's repository (Kiln builds that copy's main) and its state journal, reached by a
fake `hc` that runs each script here with its stdin, and a fake `kiln-web-service` that checks what
Kiln's developer CLI would (the base is the worktree's HEAD, the files selected are the task's) and
answers a run. Ready asks for the check, Accept waits on a running one, a pass merges, a failure holds
the merge as Needs you, and a check that can't happen holds nothing."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import sqlite3
import subprocess
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "mods", "tasks", "bin"))

from test_onix_forge import OnixRepo  # noqa: E402
from herdr_task import commands, kiln_check  # noqa: E402
from herdr_task.store import Store, locate  # noqa: E402

IDENTITY = "a" * 64

# hc: `exec [--on M] [--timeout N] [-i] -- python3 -c SCRIPT ARGS…` runs it here, its stdin passed on with -i.
FAKE_HC = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
args = sys.argv[1:]
with open(os.environ["KILN_HC_LOG"], "a") as f:
    f.write(json.dumps(args[:args.index("--")] if "--" in args else args) + "\n")
if args[:1] != ["exec"] or "--" not in args:
    sys.exit(1)
rest = args[args.index("--") + 1:]
run = [sys.executable, *rest[1:]] if rest[:1] == ["python3"] else rest
data = sys.stdin.buffer.read() if "-i" in args[:args.index("--")] else b""
done = subprocess.run(run, input=data, capture_output=True)
sys.stdout.buffer.write(done.stdout)
sys.stderr.buffer.write(done.stderr)
sys.exit(done.returncode)
'''

# kiln-web-service ci …: what the developer CLI checks before it uploads (its profile and identity, the
# worktree's HEAD is the base, each selected file is there or gone), logged; then a run.
FAKE_KILN = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
a = sys.argv[1:]
def opt(name):
    return [a[i + 1] for i, x in enumerate(a[:-1]) if x == name]
assert a[:1] == ["ci"] and a[a.index("--identity") + 1] == os.environ["KILN_IDENTITY"], a
repo = opt("--dirty-repository")[0]
head = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
if head != opt("--revision")[0]:
    print("snapshot_base_is_not_head", file=sys.stderr)
    sys.exit(1)
files = {p: open(os.path.join(repo, p)).read() for p in opt("--include")}
gone = [p for p in opt("--delete") if not os.path.exists(os.path.join(repo, p))]
with open(os.environ["KILN_LOG"], "a") as f:
    f.write(json.dumps({"project": opt("--project")[0], "request": opt("--request-id")[0], "reference": opt("--reference")[0],
                        "revision": head, "files": files, "deleted": gone}) + "\n")
print(json.dumps({"id": "web-run-7", "phase": "queued", "project_id": opt("--project")[0]}))
'''


class KilnCheck(OnixRepo):
    def setUp(self):
        super().setUp()
        self.onix_repo()
        # Kiln's machine: its own copy of the project's repository, named as the task's repo is.
        self.kiln = os.path.join(self.tmp, "kiln-host")
        os.makedirs(self.kiln)
        self.copy = os.path.join(self.kiln, "repo")
        subprocess.run(["git", "clone", "-q", self.origin, self.copy], check=True, capture_output=True)
        self.service = os.path.join(self.kiln, "service.json")
        self.project("repo-ci", self.copy)
        self.db = os.path.join(self.kiln, "service.sqlite")
        self.journal([])
        self.fake("hc", FAKE_HC)
        _, bindir = self.fake("kiln-web-service", FAKE_KILN)
        self.hc_log, self.kiln_log = os.path.join(self.tmp, "hc.log"), os.path.join(self.tmp, "kiln.log")
        p = mock.patch.dict(os.environ, {"PATH": bindir + os.pathsep + os.environ["PATH"], "KILN_HC_LOG": self.hc_log,
                                         "KILN_LOG": self.kiln_log, "KILN_IDENTITY": IDENTITY})
        p.start()
        self.addCleanup(p.stop)
        self.clock = [10_000_000]
        p = mock.patch.object(kiln_check, "now", lambda: self.clock[0])
        p.start()
        self.addCleanup(p.stop)
        self.on()

    def on(self, **kw):
        kiln = {"machine": "kiln-host", "before_merge": True, "service": self.service, "db": self.db,
                "developer": os.path.join(self.kiln, "developer.json"), "identity": IDENTITY, **kw}
        self.write_settings({"everywhere": {"onix": {"kiln": kiln}}})

    def project(self, pid, path):
        with open(self.service, "w") as f:
            json.dump({"projects": [{"id": pid, "repository_path": path, "reference": "refs/heads/main"}]}, f)

    def journal(self, runs):
        if os.path.exists(self.db):
            os.remove(self.db)
        con = sqlite3.connect(self.db)
        con.execute("create table service_state (state text)")
        con.execute("insert into service_state values (?)", (json.dumps({"runs": {r["id"]: r for r in runs}}),))
        con.commit()
        con.close()

    def run_is(self, outcome, terminal=True):
        self.journal([{"id": "web-run-7", "project_id": "repo-ci", "phase": "terminal" if terminal else "running",
                       "observation": {"outcome": outcome, "terminal": terminal}}])

    def tick(self, minutes=3):
        """One scheduler round for the folder, the clock moved on (each round is throttled)."""
        self.clock[0] += minutes * 60_000
        report = {}
        with Store(locate(self.repo), write=True) as s:
            kiln_check.check_pass(s, report, commands.onix_merge_now)
        return report

    def sent(self):
        with open(self.kiln_log) as f:
            return [json.loads(x) for x in f]

    def ready_task(self, **kw):
        wt, sha = self.task_branch(**kw)
        self.add("Check it")
        self.attach(wt)
        self.ready()
        return wt, sha

    def test_ready_asks_accept_waits_and_a_pass_merges(self):
        base = self.git(self.copy, "rev-parse", "main")
        wt, sha = self.ready_task()
        self.assertEqual(self.task()["kiln_check"]["outcome"], "pending")
        v = self.accept()
        self.assertEqual(v["accepted"], "kiln")
        self.assertNotEqual(self.git(self.origin, "rev-parse", "main"), sha)
        self.tick()
        rec = self.task()["kiln_check"]
        self.assertEqual((rec["run"], rec["project"], rec["base"], rec["outcome"]), ("web-run-7", "repo-ci", base, "pending"))
        [sent] = self.sent()
        self.assertEqual((sent["revision"], sent["reference"], sent["files"]), (base, "refs/heads/main", {"a.txt": "one\nplus\n"}))
        self.assertRegex(sent["request"], r"^shepherdr-[A-Za-z0-9_.-]+-" + sha[:12] + "$")
        self.run_is("Success", terminal=False)
        self.tick()
        self.assertEqual(self.task()["state"], "ready")  # still running: no merge
        self.run_is("Success")
        self.tick()
        t = self.task()
        self.assertEqual((t["state"], t["kiln_check"]["outcome"]), ("done", "success"))
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), sha)
        with open(self.hc_log) as f:
            self.assertTrue(all(json.loads(x)[:3] == ["exec", "--on", "kiln-host"] for x in f))

    def test_a_failure_holds_the_merge_as_needs_you(self):
        self.ready_task()
        self.tick()
        self.run_is("DomainFailure")
        report = self.tick()
        t = self.task()
        self.assertEqual(t["kiln_check"]["outcome"], "failure")
        self.assertIn("Kiln failed: repo-ci run web-run-7 ended DomainFailure", t["attention"])
        self.assertEqual(report["attention"], [t["id"]])
        with self.assertRaises(commands.Fail) as refused:
            self.accept()
        self.assertIn("needs attention first: Kiln failed", str(refused.exception))
        ev = self.show(1, evidence=True)["evidence"]
        self.assertEqual(ev["checks"]["state"], "failed")

    def test_a_deleted_file_is_deleted_there_too(self):
        self.commit(self.repo, "gone.txt", "bye\n", "a file to delete")
        self.git(self.repo, "push", "origin", "main")
        self.git(self.copy, "pull", "-q", "origin", "main")
        wt, _ = self.task_branch()
        self.git(wt, "rm", "-q", "gone.txt")
        self.git(wt, "commit", "-qm", "delete it")
        self.add("Check it")
        self.attach(wt)
        self.ready()
        self.tick()
        [sent] = self.sent()
        self.assertEqual(sent["deleted"], ["gone.txt"])

    def test_a_check_that_cant_happen_holds_nothing(self):
        # Kiln's main has a commit this repo never saw: unknown, with why, and Accept merges.
        self.commit(self.copy, "theirs.txt", "local only\n", "unpushed on Kiln's machine")
        wt, sha = self.ready_task()
        self.tick()
        rec = self.task()["kiln_check"]
        self.assertEqual(rec["outcome"], "unknown")
        self.assertIn("isn't in this repo", rec["why"])
        self.assertEqual(self.accept()["accepted"], "onix")
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), sha)

    def test_no_kiln_project_for_the_repo_is_no_check(self):
        self.project("elsewhere", os.path.join(self.kiln, "other"))
        wt, sha = self.ready_task()
        self.tick()
        rec = self.task()["kiln_check"]
        self.assertEqual(rec["outcome"], "none")
        self.assertEqual(self.accept()["accepted"], "onix")

    def test_a_run_kiln_lost_holds_nothing(self):
        """Kiln's own `unknown` phase (its provider's answer was ambiguous) never becomes a verdict by itself."""
        wt, sha = self.ready_task()
        self.tick()
        self.journal([{"id": "web-run-7", "project_id": "repo-ci", "phase": "unknown", "error_code": "provider_unknown",
                       "observation": None}])
        self.tick()
        rec = self.task()["kiln_check"]
        self.assertEqual(rec["outcome"], "unknown")
        self.assertIn("unknown in Kiln (provider_unknown)", rec["why"])
        self.assertEqual(self.accept()["accepted"], "onix")
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), sha)

    def test_nothing_is_sent_while_a_lost_run_holds_the_project(self):
        self.journal([{"id": "web-run-1", "project_id": "repo-ci", "phase": "unknown", "error_code": "provider_unknown",
                       "observation": None}])
        self.ready_task()
        self.tick()
        rec = self.task()["kiln_check"]
        self.assertEqual(rec["outcome"], "unknown")
        self.assertIn("held by run web-run-1", rec["why"])
        self.assertFalse(os.path.exists(self.kiln_log))

    def test_auto_merge_waits_for_the_pass(self):
        self.write_settings({"everywhere": {"tasks": {"merge": "auto"}, "onix": {"kiln": {
            "machine": "kiln-host", "before_merge": True, "service": self.service, "db": self.db,
            "developer": "/x", "identity": IDENTITY}}}})
        wt, sha = self.ready_task()
        self.assertEqual(self.task()["state"], "ready")
        self.tick()
        self.run_is("Success")
        self.tick()
        self.assertEqual(self.task()["state"], "done")
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), sha)

    def test_off_unless_before_merge(self):
        self.on(before_merge=False)
        wt, sha = self.ready_task()
        self.assertNotIn("kiln_check", self.task())
        self.assertEqual(self.accept()["accepted"], "onix")


if __name__ == "__main__":
    unittest.main()
