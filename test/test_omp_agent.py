"""onix: omp as a first-class herdr-task agent kind (contract A).

argv_for's omp branch (model, thinking, approval mode, the ":" rule), the reviewer command and the helper
hc line that runs it, resuming (--resume) and reviving after a crash (--restore), the environment strip
every launch and revive line carries, session discovery from a fake /proc tree, and reading an omp
session log (a tree: only the chain from the newest entry back is live), provider errors included.
Claude Code's and Codex's own behaviour is test_herdr_task's.
"""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import re
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

from herdr_task import agents, cli, feedback, launch, output, provider, revive, sessions, settings, takeover  # noqa: E402

UUID = "01a1db34-4a6a-77a0-84d5-2b0bd4a4a97d"
SESSION = f"2026-11-14T17-56-39-658Z_{UUID}.jsonl"


def omp_lines(records):
    """An omp session log's lines: its header and title, then the records as written (compact JSON)."""
    head = [{"type": "title", "v": 1, "title": "onix", "source": "auto"},
            {"type": "session", "version": 3, "id": UUID, "timestamp": "2026-11-14T17:56:39.658Z", "cwd": "/tmp/w"}]
    return [json.dumps(d, separators=(",", ":")) for d in head + records]


def message(role, content, id=None, parent_id=None, **extra):
    m = {"role": role, "content": content, "timestamp": 1763131000000}
    m.update(extra)
    return {"type": "message", "id": id, "parentId": parent_id, "timestamp": "2026-11-14T17:56:39.706Z", "message": m}


def text(t):
    return [{"type": "text", "text": t}]


def tool_call(i, name, **arguments):
    return [{"type": "toolCall", "id": i, "name": name, "arguments": arguments, "intent": name}]


class Logs(unittest.TestCase):
    """A file under a throwaway folder that reads as an omp session."""

    def write(self, records):
        d = tempfile.mkdtemp()
        path = os.path.join(d, SESSION)
        with open(path, "w") as f:
            f.write("\n".join(omp_lines(records)) + "\n")
        return path


class Settings(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        p = mock.patch.object(settings, "SETTINGS", os.path.join(self.tmp, "settings.json"))
        p.start()
        self.addCleanup(p.stop)

    def test_each_permission_is_omps_nearest_approval_mode(self):
        want = {None: "always-ask-cached", "manual": "always-ask-cached", "auto": "write", "acceptEdits": "write",
                "plan": "always-ask-cached", "read-only": "always-ask-cached", "bypassPermissions": "yolo",
                "full": "yolo", "yolo": "yolo", "write": "write"}
        for perm, mode in want.items():
            pick = {"agent": "omp"} if perm is None else {"agent": "omp", "perm": perm}
            self.assertEqual(settings.argv_for(pick), ["omp", "--approval-mode", mode], perm)

    def test_model_and_thinking_are_flags(self):
        self.assertEqual(settings.argv_for({"agent": "omp", "model": "underclass/deepseek-v4.1-flash",
                                            "effort": "high", "perm": "auto"}),
                         ["omp", "--model", "underclass/deepseek-v4.1-flash", "--thinking", "high",
                          "--approval-mode", "write"])
        for effort in sorted(settings.OMP_THINKING):
            self.assertIn("--thinking", settings.argv_for({"agent": "omp", "effort": effort}))

    def test_a_colon_model_is_a_thinking_level_unless_free(self):
        with self.assertRaises(settings.Fail) as e:
            settings.argv_for({"agent": "omp", "model": "underclass/deepseek-v4.1-flash:high"})
        self.assertIn("thinking level", str(e.exception))
        self.assertEqual(settings.argv_for({"agent": "omp", "model": "underclass/deepseek-v4.1-flash:free"}),
                         ["omp", "--model", "underclass/deepseek-v4.1-flash:free", "--approval-mode", "always-ask-cached"])

    def test_thinking_outside_omps_levels_is_refused(self):
        with self.assertRaises(settings.Fail) as e:
            settings.argv_for({"agent": "omp", "effort": "ultra"})
        self.assertIn("--thinking", str(e.exception))

    def test_agent_argv_omp_is_omp_itself(self):
        self.assertEqual(settings.agent_argv("omp"), ["omp"])  # no --no-daemon, no wrapper
        self.assertEqual(settings.agent_key(["omp", "--model", "x"]), "omp")

    def test_argv_model_reads_thinking(self):
        self.assertEqual(settings.argv_model(["omp", "--model", "underclass/x", "--thinking", "xhigh",
                                              "--approval-mode", "write"]), ("underclass/x", "xhigh"))

    def test_the_reviewer_command_is_ask_and_remember(self):
        self.assertEqual(settings.reviewer_command("omp"), "omp --approval-mode always-ask-cached")
        self.assertEqual(settings.reviewer_command("omp", "mesh/spark", "medium"),
                         shlex.join(["omp", "--approval-mode", "always-ask-cached", "--model", "mesh/spark", "--thinking", "medium"]))

    def test_a_task_agent_omp_start_from_settings(self):
        """--agent omp (no model, no effort) still says its approval mode, never omp's own yolo default."""
        s = SimpleNamespace(loc={"kind": "folder", "folder": self.tmp})
        task = {"agent": "omp", "agents": []}
        self.assertEqual(settings.worker_argv(s, task), ["omp", "--approval-mode", "always-ask-cached"])

    def test_omps_own_name_and_sign_in(self):
        self.assertEqual(settings.CLI_NAMES["omp"], "omp")
        self.assertEqual(takeover.NAMES["omp"], "omp")
        self.assertEqual(takeover.cli_state("ready"), "ready")
        self.assertEqual(takeover.cli_state("missing"), "missing")
        self.assertIn("command -v omp", takeover.CHECK)
        self.assertIn('echo omp=ready', takeover.CHECK)
        # omp has no login command to offer: the brief names the program, not a command that doesn't exist
        self.assertNotIn("omp", settings.LOGIN)

    def test_codex_model_catalog_says_nothing_about_an_omp_reviewer(self):
        with mock.patch.object(settings, "codex_lacks", lambda m: ["gpt-5.2"]):
            settings.check_reviewer_model({"reviewer": "omp", "reviewer_model": "underclass/deepseek-v4.1-flash"})
            settings.check_reviewer_model({"reviewer": "claude", "reviewer_model": "claude-opus-5-5"})
            with self.assertRaises(settings.Fail):
                settings.check_reviewer_model({"reviewer_model": "totally-unknown"})

    def test_a_tasks_reviewer_defaults_to_omp_itself(self):
        """No automatic cross-pick for omp: its reviewer is omp (claude and codex swap, omp never does)."""
        s = SimpleNamespace(loc={"kind": "folder", "folder": self.tmp})
        lines = settings.task_settings(s, {"id": 1, "title": "t", "agents": [{"argv": ["omp", "--approval-mode", "write"]}],
                                          "set": {"review": "on"}}, None, ["omp", "--approval-mode", "write"])
        rv = next(x["value"] for x in lines if x["label"] == "Reviewer")
        self.assertEqual(rv["agent"], "omp")
        self.assertEqual(rv["command"], "omp --approval-mode always-ask-cached")


class Launch(unittest.TestCase):
    def test_own_argv_adds_nothing_to_omp_but_its_own_overlay(self):
        """No hook, no --settings for omp: only the --config of its own allow rules (OwnConfig below)."""
        argv = ["omp", "--model", "underclass/x", "--approval-mode", "write"]
        with mock.patch.object(launch, "secret_path", lambda: None), mock.patch.object(launch, "browser_path", lambda: None), \
                mock.patch.object(launch, "beside_store", lambda kind, name: os.path.join(tempfile.mkdtemp(), name)):
            out = launch.own_argv(argv, "/tmp")
        self.assertEqual([a for a in out if a not in argv], ["--config", out[2]])
        self.assertEqual(out[:1] + out[3:], argv)

    def test_resume_keeps_the_flags_it_started_with(self):
        argv = ["omp", "--model", "underclass/x", "--thinking", "high", "--approval-mode", "write"]
        self.assertEqual(launch.resume_argv(argv, "/home/me/.omp/agent/sessions/-git-w/" + SESSION),
                         argv + ["--resume", "/home/me/.omp/agent/sessions/-git-w/" + SESSION])
        self.assertIsNone(launch.resume_argv(["vim"], "/x"))

    def test_every_launch_strips_a_parent_omp_session(self):
        self.assertEqual(launch.clean_env(["omp"]),
                         ["sh", "-c", launch.CLEAN_ENV + " " + launch.AGENT_ENV + ' exec "$@"', "herdr-clean", "omp"])
        vars_ = ("PI_SESSION_FILE", "PI_SESSION_ID", "OMPCODE")
        env = {**os.environ, **{v: "parent" for v in vars_}, "UNTOUCHED": "kept"}
        script = 'printf "%s;" ' + " ".join(f'"${{{v}-none}}"' for v in (*vars_, "UNTOUCHED"))
        r = subprocess.run(launch.clean_env(["sh", "-c", script]),
                           capture_output=True, text=True, env=env)
        self.assertEqual(r.stdout, "none;none;none;kept;", r.stderr)

    def test_the_brief_never_promises_an_omp_runs_unasked(self):
        s = SimpleNamespace(loc={"kind": "folder", "folder": tempfile.mkdtemp()}, ref=lambda t: "DEV-1")
        task = {"id": 1, "title": "t", "mode": "here", "agents": []}
        omp = launch.closing_line(s, task, None, ["omp", "--approval-mode", "always-ask-cached"])
        self.assertIn("omp may first ask", omp)
        self.assertNotIn("then its ready, reviewed", omp)
        self.assertNotIn("sandbox_permissions", omp)
        claude = launch.closing_line(s, task, None, ["claude"])
        self.assertIn("commands run without asking", claude)
        self.assertNotIn("omp may first ask", claude)

    def test_the_helper_hc_line_accepts_an_omp_reviewer(self):
        words = shlex.split("hc run --bg --name dev-1-review --label herdr.role=reviewer --label herdr.agent=omp -- "
                            "omp --approval-mode always-ask-cached --model underclass/deepseek-v4.1-flash "
                            "--thinking high 'review this'")
        self.assertTrue(launch.helper_hc(words))
        wide = shlex.split("hc run --bg --label herdr.agent=omp -- omp --approval-mode yolo 'do the task'")
        self.assertFalse(launch.helper_hc(wide))  # a worker, not a reviewer
        self.assertTrue(launch.helper_hc(["hc", "wait", "dev-1-review"]))


class OwnConfig(unittest.TestCase):
    """onix: an omp worker's own commands as a --config overlay of omp bash.patterns, which omp prepends
    ahead of the global ones (`omp config get bash.patterns --json` with PI_CONFIG_FILES shows them first):
    a Write or Ask-and-remember worker then runs herdr-task, herdr-secret and its browser unasked."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state = os.path.join(self.tmp, "state")
        self.ht, self.secret, self.browser = ("/home/me/.local/bin/herdr-task", "/home/me/.local/bin/herdr-secret",
                                             "/home/me/.local/bin/herdr-browser")
        for name, value in (("beside_store", lambda kind, name: os.path.join(self.state, name)),
                            ("own_path", lambda: self.ht), ("secret_path", lambda: self.secret),
                            ("browser_path", lambda: self.browser)):
            p = mock.patch.object(launch, name, value)
            p.start()
            self.addCleanup(p.stop)

    def translated(self, rules):
        """Claude's rules as the same omp patterns: Bash(<program> <verb>:*) -> {match: <program> <verb>*}."""
        out = []
        for r in rules:
            m = re.fullmatch(r"Bash\((.*):\*\)", r)
            self.assertIsNotNone(m, r)
            out.append({"match": m.group(1) + "*", "approval": "allow"})
        return out

    def argv(self, folder="/tmp/w"):
        return launch.own_argv(["omp", "--approval-mode", "write"], folder)

    def test_the_overlay_mirrors_claudes_rules_exactly(self):
        rules = launch.own_omp_rules(self.ht)
        self.assertEqual(rules, self.translated(launch.own_rules(self.ht)))
        self.assertEqual(rules[0], {"match": f"{self.ht} ready*", "approval": "allow"})
        self.assertEqual(rules[1], {"match": f"{self.ht} reviewed*", "approval": "allow"})
        self.assertEqual(rules[-2:], [{"match": f"{self.browser}*", "approval": "allow"},
                                      {"match": "herdr-browser*", "approval": "allow"}])
        self.assertTrue(all(r["approval"] == "allow" for r in rules))
        self.assertEqual([r["match"] for r in rules if r["match"] == f"{self.secret} ask*"], [f"{self.secret} ask*"])
        self.assertEqual([r["match"] for r in rules if r["match"] == "herdr-secret list*"], ["herdr-secret list*"])

    def test_the_launch_gets_the_overlay_file_right_after_omp(self):
        argv = self.argv()
        self.assertEqual(argv[:2], ["omp", "--config"])
        conf = argv[2]
        self.assertEqual(argv[3:], ["--approval-mode", "write"])
        self.assertTrue(conf.startswith(os.path.join(self.state, "omp") + os.sep), conf)
        with open(conf) as f:
            self.assertEqual(json.load(f), {"bash": {"patterns": launch.own_omp_rules(self.ht)}})

    def test_a_relaunch_keeps_one_identical_overlay(self):
        argv = self.argv()
        conf = argv[2]
        before = os.stat(conf)
        self.assertEqual(self.argv(), argv)                       # the same rules: the same file and one flag
        self.assertEqual(launch.own_argv(argv, "/tmp/w"), argv)    # an argv that already carries it is left alone
        self.assertEqual(launch.own_argv(argv, "/tmp/w").count("--config"), 1)
        self.assertEqual(launch.own_argv(["omp", f"--config={conf}", "--approval-mode", "write"]),
                         ["omp", f"--config={conf}", "--approval-mode", "write"])
        after = os.stat(conf)
        self.assertEqual((after.st_ino, after.st_mtime_ns), (before.st_ino, before.st_mtime_ns))  # written once
        self.assertEqual(os.listdir(os.path.dirname(conf)), [os.path.basename(conf)])

    def test_a_different_overlay_does_not_block_ours(self):
        conf = self.argv()[2]
        out = launch.own_argv(["omp", "--config", "/elsewhere.json"], "/tmp/w")
        self.assertEqual(out[:3], ["omp", "--config", conf])
        self.assertIn("/elsewhere.json", out)

    def test_a_path_a_rule_cant_state_gets_no_flag(self):
        with mock.patch.object(launch, "own_path", lambda: "/opt/my tools/herdr-task"):
            self.assertEqual(self.argv(), ["omp", "--approval-mode", "write"])
        self.assertFalse(os.path.exists(os.path.join(self.state, "omp")))

    def test_resume_and_restore_keep_the_overlay(self):
        argv = self.argv()
        conf = argv[2]
        resumed = launch.resume_argv(argv, "/s/" + SESSION)
        self.assertEqual(resumed[:3], argv[:3])
        self.assertEqual(resumed[resumed.index("--config") + 1], conf)
        kind, base = revive.base_argv(argv)
        self.assertEqual((kind, base), ("omp", argv))              # --config is no session flag
        restored = revive.resume_argv(kind, base, "/s/" + SESSION, "carry on")
        self.assertEqual(restored[restored.index("--config") + 1], conf)
        self.assertIn("--restore", restored)


class Revive(unittest.TestCase):
    def test_omp_is_a_kind(self):
        self.assertEqual(revive.kind_of("/nix/store/x/bin/omp"), "omp")
        self.assertIsNone(revive.kind_of("vim"))

    def test_base_argv_drops_what_resumed_and_the_message(self):
        kind, argv = revive.base_argv(["omp", "--model", "underclass/x", "--thinking", "high", "--approval-mode",
                                       "write", "--resume", "/s/" + SESSION, "a first message"])
        self.assertEqual((kind, argv), ("omp", ["omp", "--model", "underclass/x", "--thinking", "high",
                                                "--approval-mode", "write"]))
        for form in (["omp", "--restore", "/s/" + SESSION], ["omp", "--resume=/s/" + SESSION], ["omp", "-c"]):
            self.assertEqual(revive.base_argv(form), ("omp", ["omp"]))
        self.assertEqual(revive.base_argv(["/usr/bin/omp", "--model", "m"]), ("omp", ["/usr/bin/omp", "--model", "m"]))

    def test_a_crash_revives_with_restore(self):
        argv = ["omp", "--model", "underclass/x", "--approval-mode", "write"]
        self.assertEqual(revive.resume_argv("omp", argv, "/s/" + SESSION, "carry on"),
                         ["omp", "--model", "underclass/x", "--approval-mode", "write", "--restore", "/s/" + SESSION,
                          "carry on"])
        self.assertEqual(revive.session_word({"kind": "omp", "session": UUID, "log": "/s/" + SESSION}), "/s/" + SESSION)
        self.assertEqual(revive.session_word({"kind": "claude", "session": UUID, "log": "/s/x.jsonl"}), UUID)

    def test_the_revive_line_strips_a_parent_omp_session(self):
        line = revive.shell_line("/bin/bash", "/w", {}, ["omp", "--approval-mode", "write"])
        self.assertTrue(line.startswith(launch.CLEAN_ENV + " " + launch.AGENT_ENV + " "), line)
        self.assertIn("cd /w && omp --approval-mode write", line)
        claude = revive.shell_line("/bin/bash", "/w", {}, ["claude"])
        self.assertTrue(claude.startswith(launch.CLEAN_ENV + " cd /w && claude"), claude)


class Session(unittest.TestCase):
    """omp's session, found from a fake /proc tree and its session folder."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.proc = os.path.join(self.root, "proc")
        os.makedirs(os.path.join(self.proc, "self"))
        self.home = os.path.join(self.root, "home")
        os.makedirs(self.home)
        sessions._table.update(at=None, children={})
        for mod, name, value in ((sessions, "PROC", self.proc), (sessions, "HOME", self.home)):
            p = mock.patch.object(mod, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(sessions._table.update, at=None, children={})

    def pid(self, pid, ppid=1, cwd=None, fds=(), comm="omp"):
        d = os.path.join(self.proc, str(pid))
        os.makedirs(os.path.join(d, "fd"))
        with open(os.path.join(d, "stat"), "w") as f:
            f.write(f"{pid} (omp) S {ppid} 0 0 0\n")
        with open(os.path.join(d, "comm"), "w") as f:
            f.write(comm + "\n")
        if cwd:
            os.symlink(cwd, os.path.join(d, "cwd"))
        for i, target in enumerate(fds):
            os.symlink(target, os.path.join(d, "fd", str(i + 3)))
        return d

    def log(self, name=SESSION, folder=None, body=""):
        d = os.path.join(self.home, ".omp", "agent", "sessions", folder)
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, name)
        with open(path, "w") as f:
            f.write(body)
        return path

    def test_the_file_it_holds_open_is_its_session(self):
        path = self.log(folder="-git-w")
        self.pid(4242, cwd=os.path.join(self.home, "git", "w"), fds=[path, "/home/me/.omp/agent/agent.db"])
        self.assertEqual(sessions.session_of(4242), (UUID, path))

    def test_a_child_holds_it_too(self):
        path = self.log(folder="-git-w")
        self.pid(4242, cwd=os.path.join(self.home, "elsewhere"))  # no session of its own there
        self.pid(4243, ppid=4242, cwd=os.path.join(self.home, "git", "w"), fds=[path])
        self.assertEqual(sessions.session_of(4242), (UUID, path))

    def test_the_newest_one_in_its_folders_session_folder_is_the_fallback(self):
        cwd = os.path.join(self.home, "git", "w")
        os.makedirs(cwd)
        pid_dir = self.pid(4244, cwd=cwd)
        path = self.log(folder=sessions.omp_dir(cwd))
        other = self.log("2026-01-01T00-00-00-000Z_01a10000-0000-7000-8000-000000000000.jsonl",
                         folder=sessions.omp_dir(cwd))
        os.utime(other, (1, 1))  # an older session in the same folder
        self.assertGreaterEqual(os.path.getmtime(path), os.stat(pid_dir).st_mtime)
        self.assertEqual(sessions.session_of(4244), (UUID, path))

    def test_a_subagents_journal_is_never_the_session(self):
        cwd = os.path.join(self.home, "git", "w")
        os.makedirs(cwd)
        self.pid(4245, cwd=cwd)
        stem = SESSION[:-len(".jsonl")]
        os.makedirs(os.path.join(self.home, ".omp", "agent", "sessions", "-git-w", stem), exist_ok=True)
        with open(os.path.join(self.home, ".omp", "agent", "sessions", "-git-w", stem, "Fix138.jsonl"), "w") as f:
            f.write("{}\n")
        self.assertEqual(sessions.session_of(4245), (None, None))

    def test_another_cli_in_the_same_folder_takes_no_omps_session(self):
        cwd = os.path.join(self.home, "git", "w")
        os.makedirs(cwd)
        self.pid(4246, cwd=cwd, comm="claude")
        self.log(folder=sessions.omp_dir(cwd))
        self.assertEqual(sessions.session_of(4246), (None, None))

    def test_the_cwd_slug_is_omps(self):
        with mock.patch.object(sessions, "HOME", "/srv/h"):
            self.assertEqual(sessions.omp_dir("/srv/h"), "-")
            self.assertEqual(sessions.omp_dir("/srv/h/git/onixos"), "-git-onixos")
        for folder, want in (("/tmp", "-tmp"), ("/tmp/scratch-1", "-tmp-scratch-1"), ("/srv/x", "--srv-x--")):
            self.assertEqual(sessions.omp_dir(folder), want, folder)

    def test_a_lost_log_is_found_by_its_session(self):
        path = self.log(folder="-git-w")
        self.assertEqual(sessions.log_by_session("omp", UUID), path)
        a = {"agent": "omp", "session": UUID}
        self.assertEqual(sessions.find_log(a, "DEV-1", []), path)


class Records(Logs):
    """Reading an omp session log: records, the live chain, its words, asks and provider errors."""

    def test_an_abandoned_branch_is_not_the_conversation(self):
        path = self.write([
            message("assistant", text("first"), id="a1"),
            message("user", text("retried"), id="x1", parent_id="a1"),           # abandoned
            message("user", text("go on"), id="u1", parent_id="a1"),
            message("assistant", text("work"), id="a2", parent_id="u1"),
            message("assistant", text("abandoned words"), id="b1", parent_id="x1"),  # abandoned
            message("assistant", text("done"), id="a3", parent_id="a2"),
        ])
        tail = agents.log_tail(path)
        self.assertEqual([d["id"] for d in tail], ["a1", "u1", "a2", "a3"])
        self.assertEqual([agents.said(d) for d in tail], ["first", None, "work", "done"])
        self.assertEqual([agents.from_person(d) for d in tail], [None, "go on", None, None])

    def test_thinking_and_tool_calls_are_no_words(self):
        path = self.write([
            message("assistant", [{"type": "thinking", "thinking": "hmm"}], id="a1"),
            message("assistant", [*tool_call("c1", "bash", command="ls"), *text("")], id="a2", parent_id="a1"),
            message("toolResult", text("a b"), id="t1", parent_id="a2", toolCallId="c1", toolName="bash", isError=False),
        ])
        tail = agents.log_tail(path)
        self.assertEqual(agents.said(tail[0]), "")
        self.assertEqual(agents.said(tail[1]), "")
        self.assertIsNone(agents.from_person(tail[2]))  # a tool's result is never someone writing

    def test_the_open_tool_call_is_what_it_waits_on(self):
        task = {"agents": [{"log": self.write([
            message("assistant", tool_call("c1", "bash", command="npm test"), id="a1"),
            message("toolResult", text("ok"), id="t1", parent_id="a1", toolCallId="c1", toolName="bash"),
            message("assistant", tool_call("c2", "bash", command="npm run build"), id="a2", parent_id="t1"),
        ])}]}
        self.assertEqual(agents.ask_reason(task, None), "Run: npm run build")

    def test_a_question_is_beside_a_plan(self):
        q = [{"id": "q", "question": "Restart the service now?", "options": []}]
        task = {"agents": [{"log": self.write([message("assistant", tool_call("c1", "ask", questions=q), id="a1")])}]}
        self.assertEqual(agents.ask_reason(task, None), "Restart the service now?")

    def test_an_abandoned_branchs_question_is_not_asked(self):
        task = {"agents": [{"log": self.write([
            message("assistant", text("Shall I take the window?"), id="a1"),
            message("user", text("no, retry"), id="x1", parent_id="a1"),      # abandoned
            message("assistant", text("nope?"), id="b1", parent_id="x1"),    # abandoned
            message("user", text("carry on"), id="u1", parent_id="a1"),
            message("assistant", text("Done."), id="a2", parent_id="u1"),
        ])}]}
        self.assertIsNone(agents.last_question(task))

    def test_an_open_tool_call_is_its_own_work(self):
        started = 1763132200000  # the records' own timestamps, a minute after their turn began
        with mock.patch.object(agents, "now", lambda: started):
            path = self.write([message("assistant", tool_call("c1", "bash", command="npm test"), id="a1")])
            agents._bg_cache.clear()
            self.assertEqual(agents.open_tool(path)[0], "bash")
            path = self.write([
                message("assistant", tool_call("c1", "bash", command="npm test"), id="a1"),
                message("toolResult", text("ok"), id="t1", parent_id="a1", toolCallId="c1", toolName="bash"),
            ])
            self.assertIsNone(agents.open_tool(path))

    def test_a_provider_error_is_a_cut(self):
        path = self.write([
            message("user", text("go"), id="u1"),
            message("assistant", [], id="a1", parent_id="u1", stopReason="error", errorStatus=429,
                    errorMessage="429 Too Many Requests: rate limited"),
        ])
        cut = provider.provider_cut(path)
        self.assertEqual((cut["status"], cut["tries"]), (429, 1))
        self.assertIn("429", cut["text"])
        self.assertTrue(provider.provider_error(cut["text"], cut["code"], cut["status"])["passing"])
        self.assertIsNotNone(cut["at"])

    def test_an_expired_key_is_no_passing_cut(self):
        path = self.write([
            message("assistant", [], id="a1", stopReason="error", errorStatus=401,
                    errorMessage="401 This API key has expired."),
        ])
        cut = provider.provider_cut(path)
        self.assertFalse(provider.provider_error(cut["text"], cut["code"], cut["status"])["passing"])
        self.assertEqual(provider.provider_error(cut["text"], cut["code"], cut["status"])["reason"],
                         provider.REASONS["signed_out"])

    def test_a_turn_that_carried_on_is_no_cut(self):
        path = self.write([
            message("assistant", [], id="a1", stopReason="error", errorStatus=529, errorMessage="Overloaded"),
            message("assistant", text("worked"), id="a2", parent_id="a1", stopReason="stop"),
        ])
        self.assertIsNone(provider.provider_cut(path))

    def test_each_try_counts_until_someone_writes_again(self):
        path = self.write([
            message("assistant", [], id="a1", stopReason="error", errorStatus=529, errorMessage="Overloaded"),
            message("user", text(provider.NUDGE.format("Provider overloaded")), id="u1", parent_id="a1"),
            message("assistant", [], id="a2", parent_id="u1", stopReason="error", errorStatus=529,
                    errorMessage="Overloaded"),
        ])
        self.assertEqual(provider.provider_cut(path)["tries"], 2)
        path = self.write([
            message("assistant", [], id="a1", stopReason="error", errorStatus=529, errorMessage="Overloaded"),
            message("user", text("try it again"), id="u1", parent_id="a1"),
            message("assistant", [], id="a2", parent_id="u1", stopReason="error", errorStatus=529,
                    errorMessage="Overloaded"),
        ])
        self.assertEqual(provider.provider_cut(path)["tries"], 1)


class Small(unittest.TestCase):
    def test_the_subagents_cli_reads_omp(self):
        self.assertEqual(output.subagent({"address": "a", "labels": {"herdr.agent": "omp"}})["agent"], "omp")
        self.assertEqual(output.subagent({"address": "a", "agent": "/nix/store/x/bin/omp"})["agent"], "omp")

    def test_omps_version_for_feedback(self):
        r = subprocess.CompletedProcess(["omp", "--version"], 0, "omp/18.22.0\n", "")
        with mock.patch.object(feedback.subprocess, "run", lambda *a, **k: r):
            self.assertEqual(feedback.cli_version("omp"), "omp/18.22.0")
            self.assertEqual(feedback.environment("omp")["agent"], "omp omp/18.22.0")

    def test_the_command_line_takes_omp_as_an_agent(self):
        args = []
        with mock.patch.object(cli, "cmd_add", lambda a: args.append(a)):
            argv, sys.argv = sys.argv, ["herdr-task", "add", "a title", "--agent", "omp", "--folder", "here"]
            try:
                cli.main()
            finally:
                sys.argv = argv
        self.assertEqual(args[0].agent, "omp")

    def test_the_backup_never_cross_picks_omp(self):
        s = SimpleNamespace(loc={"folder": tempfile.mkdtemp()})
        with mock.patch.object(takeover, "here_state", lambda kind: "ready"), \
                mock.patch.object(takeover, "settings_for", lambda s, space: {}):
            self.assertEqual(takeover.backup_for(SimpleNamespace(loc={}), {}, "omp"), (None, "no backup"))
            self.assertEqual(takeover.backup_for(s, {}, "claude"), ("codex", None))
            with mock.patch.object(takeover, "settings_for", lambda s, space: {"backup": {"agent": "omp"}}):
                self.assertEqual(takeover.backup_for(s, {}, "claude"), ("omp", None))
        self.assertEqual(takeover.backup_argv(s, {}, "omp"),
                         ["omp", "--approval-mode", "always-ask-cached"])


if __name__ == "__main__":
    unittest.main()
