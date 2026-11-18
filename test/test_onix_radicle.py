"""onix: Radicle patches as an Onix repo's merge path (herdr_task/radicle.py, onix.merge).

A real Radicle repo in a throwaway Radicle home (RAD_HOME, its own key, no node, no ssh agent): with
onix.radicle "patch", Ready opens the task's patch, Accept gives it the merged commit (a new revision
after a rebase), pushes the canonical base to rad so Radicle records the patch merged, then pushes the
base to origin; an identity that isn't a delegate merges nothing. Skipped where rad isn't installed."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import os
import shutil
import subprocess
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "mods", "tasks", "bin"))

from test_onix_forge import OnixRepo  # noqa: E402
from herdr_task import radicle  # noqa: E402

HAVE_RAD = bool(shutil.which("rad")) and bool(shutil.which("git-remote-rad"))


@unittest.skipUnless(HAVE_RAD, "rad and git-remote-rad aren't installed")
class RadiclePatches(OnixRepo):
    def setUp(self):
        super().setUp()
        env = {k: v for k, v in os.environ.items() if k != "SSH_AUTH_SOCK"}
        env.update(RAD_HOME=os.path.join(self.tmp, "radhome"), RAD_PASSPHRASE="")
        p = mock.patch.dict(os.environ, env, clear=True)
        p.start()
        self.addCleanup(p.stop)
        self.rad("auth", "--alias", "tester")
        # The clone becomes a Radicle repo too (its rad remote; origin stays, a mirror), an Onix repo by its .cairn/.
        self.onix_repo()
        self.rad("init", "--name", "onix-test", "--description", "a test repo", "--default-branch", "main",
                 "--private", "--no-confirm", "--no-seed", cwd=self.repo)
        self.write_settings({"everywhere": {"onix": {"radicle": "patch"}}})

    def rad(self, *args, cwd=None):
        r = subprocess.run(["rad", *args], cwd=cwd or self.tmp, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, f"rad {' '.join(args)}: {r.stderr or r.stdout}")
        return r.stdout.strip()

    def canonical(self):
        self.git(self.repo, "fetch", "rad")
        return self.git(self.repo, "rev-parse", "refs/remotes/rad/main")

    def test_ready_opens_the_patch_and_accept_merges_it(self):
        wt, sha = self.task_branch()
        self.add("Wire it")
        self.attach(wt)
        self.ready()
        t = self.task()
        self.assertEqual(t["state"], "ready")
        patch = t["radicle"]["patch"]
        self.assertRegex(patch, r"^[0-9a-f]{40}$")
        self.assertEqual((t["radicle"]["head"], t["radicle"]["rid"]), (sha, radicle.rid(self.repo)))
        self.assertTrue(t["radicle"]["offline"])  # no node here: the task says it stays on this machine
        self.assertEqual(radicle.patch_state(self.repo, t["radicle"]["rid"], patch), ("open", sha))
        ev = self.show(1, evidence=True)["evidence"]
        self.assertEqual(ev["radicle"]["patch"], patch)
        v = self.accept()
        self.assertEqual(v["accepted"], "onix")
        t = self.task()
        self.assertEqual(t["state"], "done")
        self.assertEqual(self.canonical(), sha)
        self.assertEqual(self.git(self.origin, "rev-parse", "main"), sha)  # the GitHub-style mirror too
        self.assertEqual((t["onix_merge"]["remote"], t["onix_merge"]["patch"]), ("rad", patch))
        self.assertEqual(t["radicle"]["state"], "merged")
        self.assertEqual(radicle.patch_state(self.repo, t["radicle"]["rid"], patch)[0], "merged")

    def test_a_rebase_gives_the_patch_the_commit_that_lands(self):
        wt, first = self.task_branch()
        self.add("Wire it")
        self.attach(wt)
        self.ready()
        patch = self.task()["radicle"]["patch"]
        # Someone else's work lands on the canonical base meanwhile.
        self.commit(self.repo, "b.txt", "other\n", "other work")
        self.git(self.repo, "push", "rad", "main")
        self.accept()
        t = self.task()
        self.assertEqual(t["state"], "done")
        landed = t["onix_merge"]["sha"]
        self.assertNotEqual(landed, first)
        self.assertEqual(self.canonical(), landed)
        self.assertEqual(radicle.patch_state(self.repo, t["radicle"]["rid"], patch), ("merged", landed))

    def test_only_a_delegate_merges(self):
        wt, sha = self.task_branch()
        self.add("Wire it")
        self.attach(wt)
        self.ready()
        before = self.canonical()
        real = radicle.rad

        def stranger(folder, *args, **kw):
            if args[:2] == ("self", "--did"):
                return True, "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH", ""
            return real(folder, *args, **kw)

        with mock.patch.object(radicle, "rad", stranger):
            error = self.accept_refused()
        self.assertIn("isn't one of the repo's delegates", error)
        self.assertIn("stays open for them", error)
        self.assertEqual(self.canonical(), before)
        self.assertEqual(self.task()["state"], "ready")

    def test_off_by_default_and_auto_only_in_a_radicle_repo(self):
        self.assertIsNone(radicle.mode({}, self.repo))
        self.assertEqual(radicle.mode({"radicle": "auto"}, self.repo), "patch")
        self.assertEqual(radicle.mode({"radicle": "auto"}, self.seed), None)
        self.assertEqual(radicle.mode({"radicle": "patch"}, self.seed), "patch")


if __name__ == "__main__":
    unittest.main()
