"""onix: the forge a repo uses, the Onix merge (fast-forward the base and push it, never a pull
request) and the linked Cairn change's read-only gates (contract C).

Real throwaway repos: a bare origin and a clone from it. herdr-task runs in process against a
test's own task list and settings (Store.STORE, settings.SETTINGS), and its hc reads are replaced
(test/home_guard.py keeps every test off the person's machine)."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import argparse
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "mods", "tasks", "bin")
sys.path.insert(0, BIN)

from herdr_task import cli, commands, github, onix  # noqa: E402
from herdr_task import settings as st  # noqa: E402
from herdr_task import store as store_mod  # noqa: E402
from herdr_task.base import Fail, now  # noqa: E402
from herdr_task.store import Store, locate  # noqa: E402


class S:
    """The part of a Store onix.py and github() read: its folder and where they cache."""

    def __init__(self, folder, kind="repo"):
        self.loc = {"folder": folder, "kind": kind, "name": os.path.basename(folder)}
        self.data = {}
        self.dirty = False


class Args(argparse.Namespace):
    """A command's arguments, every one it didn't name None (getattr(args, ..., None) reads so)."""

    def __getattr__(self, name):
        return None


# A cairn that speaks the machine envelope, with what it says chosen by $CAIRN_MODE: pass, fail,
# invalid (validate says invalid) or error (no envelope at all, as a policy skew gives); every
# call logged to $CAIRN_LOG.
CAIRN = """#!/bin/sh
printf '%s\\n' "$*" >> "$CAIRN_LOG"
if [ "$(cat "$CAIRN_MODE" 2>/dev/null)" = error ]; then
  echo "cairn: the repo's policy is older than this binary"
  exit 3
fi
MODE="$(cat "$CAIRN_MODE" 2>/dev/null || echo pass)"
case "$*" in
  *"gate proposal"*) V=PASS ;;
  *"gate design"*) if [ "$MODE" = fail ]; then V=FAIL; else V=PASS; fi ;;
  *"gate tasks"*) V=PASS ;;
  *"validate"*)
    if [ "$MODE" = invalid ]; then V=false; else V=true; fi
    printf '{"schema_version":"cairn.cli-machine.v1","ok":true,"command":"validate","exit_class":"success","result":{"valid":%s},"diagnostics":[]}' "$V"
    exit 0 ;;
  *) echo "unexpected: $*"; exit 4 ;;
esac
printf '{"schema_version":"cairn.cli-machine.v1","ok":true,"command":"gate","exit_class":"success","result":{"verdict":"%s"},"diagnostics":[]}' "$V"
"""


class OnixRepo(unittest.TestCase):
    """Throwaway origin and clone, a test's own task list and settings, and herdr-task's commands in
    process: the fixtures (test_onix_radicle.py builds on them too)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="onix-forge-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.origin = os.path.join(self.tmp, "origin.git")
        self.git(self.tmp, "init", "--bare", "-b", "main", self.origin)
        self.seed = os.path.join(self.tmp, "seed")
        os.makedirs(self.seed)
        self.git(self.seed, "init", "-b", "main")
        self.commit(self.seed, "a.txt", "one\n", "first")
        self.git(self.seed, "remote", "add", "origin", self.origin)
        self.git(self.seed, "push", "-u", "origin", "main")
        self.repo = os.path.join(self.tmp, "repo")
        subprocess.run(["git", "clone", self.origin, self.repo], check=True, capture_output=True, text=True)
        self.settings_file = os.path.join(self.tmp, "settings.json")
        self.write_settings({})
        for p in (mock.patch.object(st, "SETTINGS", self.settings_file),
                  mock.patch.object(store_mod, "STORE", os.path.join(self.tmp, "tasks"))):
            p.start()
            self.addCleanup(p.stop)
        # herdr-task's hc reads (a task's live agents) stay off the person's core: nothing is live here.
        for name, value in (("live_agents", lambda key: []), ("detail", lambda k: k), ("busy_again", lambda t, live: False)):
            p = mock.patch.object(commands, name, value)
            p.start()
            self.addCleanup(p.stop)
        for name, value in (("live_agents", lambda key: []), ("live_helpers", lambda key: []), ("hc_json", lambda *a: None)):
            p = mock.patch.object(github, name, value)
            p.start()
            self.addCleanup(p.stop)

    # ---- throwaway repos ------------------------------------------------------------------

    def git(self, cwd, *args):
        return subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, cwd, name, text, message):
        path = os.path.join(cwd, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
        self.git(cwd, "add", name)
        self.git(cwd, "commit", "-m", message)
        return self.git(cwd, "rev-parse", "HEAD")

    def write_settings(self, d):
        with open(self.settings_file, "w") as f:
            json.dump({"version": 1, "everywhere": {}, "spaces": {}, **d}, f)

    def onix_repo(self):
        """The clone with .cairn/ committed (an Onix repo by itself), on origin's main too."""
        self.commit(self.repo, ".cairn/changes/README.md", "changes\n", "onix: cairn")
        self.git(self.repo, "push", "origin", "main")

    def task_branch(self, name="wt", branch="task/1-work", text="one\nplus\n"):
        wt = os.path.join(self.tmp, name)
        self.git(self.repo, "worktree", "add", "-b", branch, wt)
        return wt, self.commit(wt, "a.txt", text, "the task's work")

    def fake(self, name, body):
        d = os.path.join(self.tmp, "bin")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, name)
        with open(path, "w") as f:
            f.write(body)
        os.chmod(path, 0o755)
        return path, d

    @contextlib.contextmanager
    def cairn(self, mode="pass"):
        self.fake("cairn", CAIRN)
        log = os.path.join(self.tmp, "cairn.log")
        mode_file = os.path.join(self.tmp, "cairn.mode")
        with open(mode_file, "w") as f:
            f.write(mode)
        with mock.patch.dict(os.environ, {"PATH": os.path.join(self.tmp, "bin") + os.pathsep + os.environ["PATH"],
                                          "CAIRN_LOG": log, "CAIRN_MODE": mode_file}):
            yield log

    # ---- herdr-task's commands, in process ------------------------------------------------

    def run_cmd(self, fn, **kw):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fn(Args(json=True, **kw))
        text = out.getvalue().strip()
        return json.loads(text) if text else None

    def cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["herdr-task", *argv]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main()
        return rc, out.getvalue(), err.getvalue()

    def add(self, title="Do the work", **kw):
        return self.run_cmd(commands.cmd_add, title=title, folder=self.repo, **kw)

    def show(self, n=1, **kw):
        return self.run_cmd(commands.cmd_show, id=str(n), folder=self.repo, **kw)

    def attach(self, wt, branch="task/1-work", n=1):
        """The task as if its agent had started it there (start is what a worktree task branches from)."""
        with Store(locate(self.repo), write=True) as s:
            t = s.find(str(n))
            t.update(mode="worktree", worktree=wt, branch=branch, state="running", start=now() - 60000, started=now() - 60000)
            s.dirty = True

    def task(self, n=1):
        with Store(locate(self.repo), write="try") as s:
            return dict(s.find(str(n)))

    def ready(self, n=1):
        return self.run_cmd(commands.cmd_ready, id=str(n), folder=self.repo, summary="It works now.")

    def accept(self, n=1):
        return self.run_cmd(commands.cmd_accept, id=str(n), folder=self.repo)

    def accept_refused(self, n=1):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(SystemExit) as caught:
            commands.cmd_accept(Args(json=True, id=str(n), folder=self.repo))
        self.assertEqual(caught.exception.code, 1)
        return json.loads(out.getvalue())["error"]


class OnixForge(OnixRepo):
    # ---- which forge a repo uses ----------------------------------------------------------

    def test_the_forge_comes_from_cairn_the_remote_or_the_setting(self):
        self.assertEqual(onix.forge(S(self.repo)), "github")
        os.makedirs(os.path.join(self.repo, ".cairn"))
        self.assertEqual(onix.forge(S(self.repo)), "onix")

        other = os.path.join(self.tmp, "other")
        subprocess.run(["git", "clone", self.origin, other], check=True, capture_output=True, text=True)
        self.assertEqual(onix.forge(S(other)), "github")
        for url in ("git@github.com:OnixResearch/thing.git", "https://github.com/onixcomputer/thing",
                    "ssh://git@github.com/OnixResearch/thing"):
            self.git(other, "remote", "set-url", "origin", url)
            self.assertEqual(onix.forge(S(other)), "onix", url)
        self.git(other, "remote", "set-url", "origin", "https://github.com/someone/thing")
        self.assertEqual(onix.forge(S(other)), "github")

        # the setting wins over the repo, at Everywhere's or the space's own level
        self.write_settings({"everywhere": {"onix": {"forge": "github"}}})
        self.assertEqual(onix.forge(S(self.repo)), "github")
        self.write_settings({"everywhere": {"onix": {"forge": "auto"}}})
        self.assertEqual(onix.forge(S(self.repo)), "onix")
        self.write_settings({"spaces": {"sp1": {"folder": self.repo, "onix": {"forge": "github"}}}})
        self.assertEqual(onix.forge(S(self.repo)), "github")
        # a plain folder is never Onix, whatever a stray .cairn there says
        os.makedirs(os.path.join(self.tmp, "plain", ".cairn"))
        self.assertEqual(onix.forge(S(os.path.join(self.tmp, "plain"), kind="folder")), "github")

    def test_an_onix_repo_never_asks_github(self):
        marker = os.path.join(self.tmp, "gh-ran")
        fake, _ = self.fake("gh", f'#!/bin/sh\ntouch "{marker}"\nexit 1\n')
        # a GitHub-mode repo does ask gh (so the check below means something)
        with mock.patch.object(github, "GH", fake):
            self.assertIsNone(github.github(S(self.repo)))
        self.assertTrue(os.path.exists(marker))
        os.unlink(marker)
        os.makedirs(os.path.join(self.repo, ".cairn"))
        with mock.patch.object(github, "GH", fake):
            self.assertIsNone(github.github(S(self.repo)))
        self.assertFalse(os.path.exists(marker))

    # ---- the Onix merge ------------------------------------------------------------------

    def test_merge_fast_forwards_the_base_and_pushes_it(self):
        os.makedirs(os.path.join(self.repo, ".cairn"))
        wt, sha = self.task_branch()
        res = onix.merge(S(self.repo), {"branch": "task/1-work", "worktree": wt})
        self.assertTrue(res["ok"], res.get("why"))
        self.assertEqual((res["sha"], res["base"]), (sha, "main"))
        self.assertIsInstance(res["at"], int)
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), sha)
        self.assertEqual(self.git(self.repo, "rev-parse", "main"), sha)
        self.assertEqual(self.git(self.repo, "merge-base", "--is-ancestor", sha, "origin/main"), "")

    def test_a_branch_that_does_not_rebase_cleanly_is_refused_never_forced(self):
        os.makedirs(os.path.join(self.repo, ".cairn"))
        wt, sha = self.task_branch()
        before = self.git(self.repo, "rev-parse", "main")
        self.commit(self.seed, "a.txt", "someone else's line\n", "someone else's change")
        self.git(self.seed, "push", "origin", "main")
        theirs = self.git(self.origin, "rev-parse", "main")
        res = onix.merge(S(self.repo), {"branch": "task/1-work", "worktree": wt})
        self.assertFalse(res["ok"])
        self.assertIn("rebase", res["why"])
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), theirs)  # nothing pushed, and never forced
        self.assertEqual(self.git(self.repo, "rev-parse", "main"), before)    # the local base is untouched
        # the worktree is left as it was: no half-done rebase, still on its branch, clean
        self.assertEqual(self.git(wt, "rev-parse", "HEAD"), sha)
        self.assertEqual(self.git(wt, "status", "--porcelain"), "")

    def test_a_task_already_on_the_base_is_already_merged(self):
        os.makedirs(os.path.join(self.repo, ".cairn"))
        wt, sha = self.task_branch()
        self.assertTrue(onix.merge(S(self.repo), {"branch": "task/1-work", "worktree": wt})["ok"])
        res = onix.merge(S(self.repo), {"branch": "task/1-work", "worktree": wt})
        self.assertTrue(res["ok"])
        self.assertTrue(res.get("already"))
        self.assertEqual(res["sha"], sha)

    def test_a_gone_worktree_never_has_main_rebased_in_its_place(self):
        os.makedirs(os.path.join(self.repo, ".cairn"))
        wt, sha = self.task_branch()
        self.git(self.repo, "worktree", "remove", wt)
        self.commit(self.seed, "a.txt", "another line\n", "elsewhere")
        self.git(self.seed, "push", "origin", "main")
        head = self.git(self.repo, "rev-parse", "HEAD")
        res = onix.merge(S(self.repo), {"branch": "task/1-work", "worktree": wt})
        self.assertFalse(res["ok"])
        self.assertIn("worktree is gone", res["why"])
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), head)  # main is untouched
        self.assertEqual(self.git(self.repo, "rev-parse", "task/1-work"), sha)

    def test_a_task_with_its_own_base_branch_merges_there(self):
        os.makedirs(os.path.join(self.repo, ".cairn"))
        self.git(self.seed, "checkout", "-b", "release")
        self.commit(self.seed, "b.txt", "release\n", "release's own")
        self.git(self.seed, "push", "origin", "release")
        self.git(self.repo, "fetch", "origin", "release")
        self.git(self.repo, "branch", "--track", "release", "origin/release")
        wt = os.path.join(self.tmp, "wt-release")
        self.git(self.repo, "worktree", "add", "-b", "task/2-release", wt, "release")
        sha = self.commit(wt, "b.txt", "release\nmore\n", "the task's work")
        main_head = self.git(self.repo, "rev-parse", "main")
        res = onix.merge(S(self.repo), {"branch": "task/2-release", "worktree": wt, "base": "release"})
        self.assertTrue(res["ok"], res.get("why"))
        self.assertEqual(res["base"], "release")
        self.assertEqual(self.git(self.origin, "rev-parse", "release"), sha)
        self.assertEqual(self.git(self.repo, "rev-parse", "release"), sha)
        self.assertEqual(self.git(self.repo, "rev-parse", "main"), main_head)
        self.assertEqual(self.git(self.repo, "merge-base", "--is-ancestor", sha, "origin/release"), "")

    # ---- Cairn's read-only gates ---------------------------------------------------------

    def test_gates_read_the_machine_envelope(self):
        os.makedirs(os.path.join(self.repo, ".cairn"))
        s, t = S(self.repo), {"cairn": "add-gates", "worktree": self.repo}
        with self.cairn("pass") as log:
            rec = onix.check_gates(s, t)
        self.assertEqual(rec["gates"], {"proposal": "PASS", "design": "PASS", "tasks": "PASS"})
        self.assertIs(rec["valid"], True)
        self.assertNotIn("why", rec)
        self.assertIsInstance(rec["at"], int)
        self.assertTrue(rec["cmd"].startswith("cairn --machine gate proposal add-gates"))
        with open(log) as f:
            self.assertEqual(f.read().splitlines(),
                             ["--machine gate proposal add-gates --root .", "--machine gate design add-gates --root .",
                              "--machine gate tasks add-gates --root .", "--machine validate --root ."])
        with self.cairn("fail"):
            rec = onix.check_gates(s, t)
        self.assertEqual(rec["gates"]["design"], "FAIL")
        self.assertEqual(onix.gate_failures(rec), "Cairn gates fail: design.")
        with self.cairn("invalid"):
            rec = onix.check_gates(s, t)
        self.assertIs(rec["valid"], False)
        self.assertIn("invalid", onix.gate_failures(rec))
        with self.cairn("error"):
            rec = onix.check_gates(s, t)
        # an error is unknown with why: it never blocks, and never reads as a pass
        self.assertEqual(set(rec["gates"].values()), {"unknown"})
        self.assertIsNone(rec["valid"])
        self.assertIn("policy is older", rec["why"])
        self.assertIsNone(onix.gate_failures(rec))

    def test_the_repo_supplies_its_own_cairn(self):
        s, t = S(self.repo), {"worktree": self.repo}
        self.assertEqual(onix.cairn_call(s, t, ["gate", "proposal", "x"])[0],
                         ["cairn", "--machine", "gate", "proposal", "x", "--root", "."])
        os.makedirs(os.path.join(self.repo, "cairn-policy", "generated"))
        with open(os.path.join(self.repo, "cairn-policy", "generated", "cairn-policy.json"), "w") as f:
            f.write("{}")
        self.assertEqual(onix.cairn_call(s, t, ["validate"])[0],
                         ["cairn", "--machine", "validate", "--root", ".", "--policy",
                          "cairn-policy/generated/cairn-policy.json"])
        os.makedirs(os.path.join(self.repo, "tools"))
        with open(os.path.join(self.repo, "tools", "cairn.mjs"), "w") as f:
            f.write("// the repo's Cairn\n")
        self.assertEqual(onix.cairn_call(s, t, ["validate"])[0][:2], ["bun", "tools/cairn.mjs"])
        self.write_settings({"spaces": {"sp1": {"folder": self.repo, "onix": {"cairn_cmd": "/opt/cairn --policy /p.json"}}}})
        self.assertEqual(onix.cairn_call(s, t, ["validate"])[0][:3], ["/opt/cairn", "--policy", "/p.json"])

    # ---- the linked change on the task ---------------------------------------------------

    def test_the_flag_and_the_brief_line_link_the_change(self):
        rc, out, _ = self.cli("add", "Wire it", "--cairn", "add-gates", "--folder", self.repo, "--json")
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["cairn"], "add-gates")
        self.assertEqual(self.show(1)["cairn"], "add-gates")

        rc, out, _ = self.cli("add", "From the brief", "--prompt", "Do it.\n\n- Cairn: other-change\n",
                              "--folder", self.repo, "--json")
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["cairn"], "other-change")

        v = self.add("No link", prompt="Just the work, no Cairn line")
        self.assertNotIn("cairn", v)
        v = self.add("Says none", prompt="Cairn: none\n")
        self.assertNotIn("cairn", v)

        rc, out, err = self.cli("add", "Bad", "--cairn", "not a slug", "--folder", self.repo, "--json")
        self.assertEqual(rc, 1)
        self.assertIn("Cairn change is named", json.loads(out)["error"])

        t = {"cairn": "add-gates", "cairn_gates": {"gates": {}}}
        onix.link(t, "")
        self.assertNotIn("cairn", t)
        self.assertNotIn("cairn_gates", t)
        with self.assertRaises(Fail):
            onix.link({}, "bad slug")

    def test_its_fields_round_trip_through_the_task_list(self):
        self.add("Fields", cairn="add-gates")
        with Store(locate(self.repo), write=True) as s:
            t = s.find("1")
            t["cairn_gates"] = {"gates": {"proposal": "PASS", "design": "PASS", "tasks": "PASS"}, "valid": True,
                                "at": 1, "cmd": "cairn --machine gate proposal add-gates --root ."}
            t["onix_merge"] = {"sha": "a" * 40, "base": "main", "at": 2}
            s.dirty = True
        v = self.show(1)
        self.assertEqual(v["cairn"], "add-gates")
        self.assertEqual(v["cairn_gates"]["gates"]["tasks"], "PASS")
        self.assertIs(v["cairn_gates"]["valid"], True)
        self.assertEqual(v["onix_merge"], {"sha": "a" * 40, "base": "main", "at": 2})

    def test_the_brief_names_the_onix_merge_and_the_cairn_change(self):
        self.onix_repo()
        wt, _ = self.task_branch()
        self.add("Wire it", cairn="add-gates")
        self.attach(wt)
        with Store(locate(self.repo)) as s:
            block = st.settings_block(s, s.find("1"))
        self.assertIn("- Forge: Onix: no pull request; after Accept, Herdr fast-forwards the base branch and pushes it", block)
        self.assertIn("- Cairn: add-gates: the Cairn change you work in", block)

    def test_a_github_repo_brief_has_no_onix_lines(self):
        wt, _ = self.task_branch()
        self.add("Wire it")
        self.attach(wt)
        with Store(locate(self.repo)) as s:
            block = st.settings_block(s, s.find("1"))
        self.assertNotIn("- Forge:", block)
        self.assertNotIn("- Cairn:", block)

    # ---- ready and Accept ----------------------------------------------------------------

    def test_accept_fast_forwards_and_pushes_without_a_pull_request(self):
        self.onix_repo()
        wt, sha = self.task_branch()
        marker = os.path.join(self.tmp, "gh-ran")
        gh, _ = self.fake("gh", f'#!/bin/sh\ntouch "{marker}"\nexit 1\n')
        self.add("Wire it", cairn="add-gates")
        self.attach(wt)
        with mock.patch.object(github, "GH", gh), self.cairn("pass"):
            self.ready()
            t = self.task()
            self.assertEqual(t["state"], "ready")
            self.assertEqual(t["cairn_gates"]["gates"], {"proposal": "PASS", "design": "PASS", "tasks": "PASS"})
            self.assertIs(t["cairn_gates"]["valid"], True)
            v = self.accept()
        self.assertEqual(v["accepted"], "onix")
        t = self.task()
        self.assertEqual(t["state"], "done")
        self.assertEqual(t["onix_merge"]["sha"], sha)
        self.assertEqual(t["onix_merge"]["base"], "main")
        self.assertIsInstance(t["onix_merge"]["at"], int)
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), sha)
        self.assertEqual(self.git(self.repo, "rev-parse", "main"), sha)
        self.assertEqual(self.git(self.repo, "merge-base", "--is-ancestor", sha, "origin/main"), "")
        self.assertFalse(os.path.exists(wt))
        self.assertFalse(os.path.exists(marker))
        # the card reads the same record
        ev = self.show(1, evidence=True)["evidence"]
        self.assertEqual((ev["forge"], ev["base"]), ("onix", "main"))
        self.assertEqual(ev["cairn"]["change"], "add-gates")
        self.assertIs(ev["cairn"]["valid"], True)

    def test_the_merge_setting_lands_it_at_ready(self):
        self.onix_repo()
        wt, sha = self.task_branch()
        self.write_settings({"everywhere": {"tasks": {"merge": "auto"}}})
        self.add("On its own", cairn="add-gates")
        self.attach(wt)
        with self.cairn("pass"):
            self.ready()
        t = self.task()
        self.assertEqual(t["state"], "done")
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), sha)
        self.assertEqual(t["onix_merge"]["sha"], sha)

    def test_a_failing_gate_stops_the_merge_and_shows_on_the_card(self):
        self.onix_repo()
        wt, sha = self.task_branch()
        self.add("Gate it", cairn="add-gates")
        self.attach(wt)
        with self.cairn("fail"):
            self.ready()
            before = self.git(self.origin, "rev-parse", "main")
            error = self.accept_refused()
        self.assertIn("Cairn gates fail: design", error)
        t = self.task()
        self.assertEqual(t["state"], "ready")
        self.assertIn("Cairn gates fail", t["attention"])
        self.assertEqual(t["cairn_gates"]["gates"]["design"], "FAIL")
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), before)
        self.assertNotIn("onix_merge", t)
        self.assertTrue(os.path.isdir(wt))
        # it is what the Accept card shows
        ev = self.show(1, evidence=True)["evidence"]
        self.assertEqual(ev["cairn"]["gates"]["design"], "FAIL")
        self.assertIn("Cairn gates fail", ev["cairn"]["why"] if ev["cairn"].get("why") else error)

    def test_a_branch_that_cannot_merge_leaves_the_task_needs_you(self):
        self.onix_repo()
        wt, sha = self.task_branch()
        # someone else lands work on origin's main meanwhile (the seed catches up first: its own push must fast-forward)
        self.git(self.seed, "fetch", "origin", "main")
        self.git(self.seed, "merge", "--ff-only", "origin/main")
        self.commit(self.seed, "a.txt", "someone else's line\n", "someone else's change")
        self.git(self.seed, "push", "origin", "main")
        theirs = self.git(self.origin, "rev-parse", "main")
        self.add("Diverged", cairn="add-gates")
        self.attach(wt)
        with self.cairn("pass"):
            self.ready()
            error = self.accept_refused()
        self.assertIn("rebase", error)
        t = self.task()
        self.assertEqual(t["state"], "ready")
        self.assertIn("rebase", t["attention"])
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), theirs)
        self.assertNotIn("onix_merge", t)
        self.assertTrue(os.path.isdir(wt))
        self.assertEqual(self.git(wt, "status", "--porcelain"), "")

    def test_the_merge_button_merges_the_onix_way(self):
        self.onix_repo()
        wt, sha = self.task_branch()
        self.add("Merge me", cairn="add-gates")
        self.attach(wt)
        with self.cairn("pass"):
            self.ready()
            v = self.run_cmd(commands.cmd_merge, id="1", folder=self.repo)
        self.assertTrue(v["merged"])
        self.assertEqual(self.task()["state"], "done")
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), sha)

    def test_an_unknown_gate_never_stops_a_merge(self):
        self.onix_repo()
        wt, sha = self.task_branch()
        self.add("No cairn here", cairn="add-gates")
        self.attach(wt)
        with self.cairn("error"):
            self.ready()
            t = self.task()
            self.assertEqual(set(t["cairn_gates"]["gates"].values()), {"unknown"})
            v = self.accept()
        self.assertEqual(v["accepted"], "onix")
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), sha)


if __name__ == "__main__":
    unittest.main()
