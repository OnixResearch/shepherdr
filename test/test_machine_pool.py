"""onix: machine.py's plan-limits reader also reads the Underclass pool (its monitor socket) and mesh-llm
(its console) where they run on this machine. They are optional: no service, no key; a slow or broken one
is unknown with its reason, never a guess. The pool reports the headroom of its best usable account per
backend and window kind, never labels, emails or ids; mesh-llm reports counts and names, never its token.

The fakes are real HTTP services: a unix-socket one for the monitor and a loopback port for the console."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(ROOT, "mods", "tasks", "bin"))
from herdr_task import machine  # noqa: E402


def reply(body, status="200 OK", chunked=False):
    """One whole HTTP answer, with a length or chunked (as axum's monitor socket may send it)."""
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    head = "HTTP/1.1 %s\r\nContent-Type: application/json\r\nConnection: close\r\n" % status
    if not chunked:
        return head.encode() + ("Content-Length: %d\r\n\r\n" % len(raw)).encode() + raw
    out = b""
    while raw:
        part, raw = raw[:7], raw[7:]
        out += ("%x\r\n" % len(part)).encode() + part + b"\r\n"
    return (head + "Transfer-Encoding: chunked\r\n\r\n").encode() + out + b"0\r\n\r\n"


class FakeHTTP:
    """A read-only HTTP service on a unix socket (`path`) or a loopback port, answering each GET from
    `routes` (path -> a whole answer; None accepts and never answers, so the reader's timeout shows)."""

    def __init__(self, routes, path=None):
        self.routes = routes
        self.held = []
        self.stopped = False
        self.sock = socket.socket(socket.AF_UNIX if path else socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(path or ("127.0.0.1", 0))
        self.path = path
        if not path:
            self.base = "http://127.0.0.1:%d" % self.sock.getsockname()[1]
        self.sock.listen(8)
        self.sock.settimeout(0.1)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        while not self.stopped:
            try:
                conn, _ = self.sock.accept()
            except (socket.timeout, TimeoutError):
                continue
            except OSError:
                return
            conn.settimeout(2)
            data = b""
            try:
                while b"\r\n\r\n" not in data:
                    part = conn.recv(4096)
                    if not part:
                        break
                    data += part
            except OSError:
                conn.close()
                continue
            route = data.split(b"\r\n", 1)[0].split(b" ")[1].decode("utf-8", "replace") if data else ""
            answer = self.routes.get(route)
            if answer is None:
                self.held.append(conn)
                continue
            try:
                conn.sendall(answer)
            except OSError:
                pass
            finally:
                conn.close()

    def close(self):
        self.stopped = True
        for sock in [self.sock] + self.held:
            try:
                sock.close()
            except OSError:
                pass
        self.thread.join(timeout=2)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# The monitor's shape (underclass src/monitor.rs): accounts with Codex's quota windows and Claude's and
# OpenCode Go's observation windows; the labels, ids and emails in it must never come back.
POOL = {
    "now_ms": 1700000000000,
    "month_start_ms": 1699000000000,
    "month": {"attempts": 40, "input_tokens": 1, "output_tokens": 1},
    "last_minute": {"attempts": 2},
    "minute_bins": [],
    "recent": [],
    "accounts": [
        {"id": "acct-one", "label": "person@example.invalid", "backend": "codex", "plan": "pro", "status": "healthy",
         "reset_at": 1700000000, "inflight": 0, "sticky_sessions": 1,
         "quota": {"rate_limit": {"primary_window": {"used_percent": 40, "reset_at": 1700000000, "limit_window_seconds": 18000},
                                  "secondary_window": {"used_percent": 88, "reset_at": 1700500000, "limit_window_seconds": 604800}},
                   "credits": {"has_credits": False}, "available_resets": 2},
         "observation": None},
        {"id": "acct-two", "label": "second@example.invalid", "backend": "codex", "plan": "pro", "status": "healthy",
         "quota": {"rate_limit": {"primary_window": {"used_percent": 12, "reset_at": 1700000100, "limit_window_seconds": 18000},
                                  "secondary_window": {"used_percent": 90, "reset_at": 1700600000, "limit_window_seconds": 604800}},
                   "available_resets": 1}},
        {"id": "acct-three", "label": "claude@example.invalid", "backend": "claude", "plan": "max", "status": "cooling",
         "observation": {"five_hour": {"utilization": 0.30, "resets_at_ms": 1700000200000},
                         "seven_day": {"utilization": 0.75, "resets_at_ms": 1700500000000},
                         "reset_credits": 0}},
        # A disabled account's near-empty windows must not count as the pool's headroom.
        {"id": "acct-off", "label": "off@example.invalid", "backend": "claude", "status": "disabled",
         "observation": {"five_hour": {"utilization": 0.01, "resets_at_ms": 1}, "seven_day": {"utilization": 0.02}}},
        # Neither does one whose sign-in failed, nor its banked resets.
        {"id": "acct-bad", "label": "bad@example.invalid", "backend": "codex", "status": "auth_error",
         "quota": {"rate_limit": {"primary_window": {"used_percent": 1, "reset_at": 2}}, "available_resets": 5}},
        {"id": "acct-go", "label": "go@example.invalid", "backend": "opencode_go", "plan": "go", "status": "healthy",
         "observation": {"monthly": {"utilization": 0.55, "resets_at_ms": 1700900000000}}},
    ],
}

POOL_WINDOWS = [
    {"name": "Codex · 5-hour", "used": 12.0, "resets_at": 1700000100000},
    {"name": "Codex · Weekly", "used": 88.0, "resets_at": 1700500000000},
    {"name": "Claude · 5-hour", "used": 30.0, "resets_at": 1700000200000},
    {"name": "Claude · Weekly", "used": 75.0, "resets_at": 1700500000000},
    {"name": "OpenCode Go · Monthly", "used": 55.0, "resets_at": 1700900000000},
]

POOL_ACCOUNTS = [
    {"backend": "codex", "status": "healthy", "plan": "pro", "resets": 2},
    {"backend": "codex", "status": "healthy", "plan": "pro", "resets": 1},
    {"backend": "claude", "status": "cooling", "plan": "max", "resets": 0},
    {"backend": "claude", "status": "disabled"},
    {"backend": "codex", "status": "auth_error", "resets": 5},
    {"backend": "opencode-go", "status": "healthy", "plan": "go"},
]

MESH_STATUS = {
    "version": "0.72.2", "node_id": "9bc5bd2725", "node_state": "serving", "node_status": "serving",
    "token": "not-for-you", "model_name": "Qwen3.8-27B",
    "peers": [{"node_id": "p1"}, {"node_id": "p2"}, {"node_id": "p3"}],
    "serving_models": ["Qwen3.8-27B", "diffusiongemma", "Qwen3.8-27B"],
    "hosted_models": ["Qwen3.8-27B"],
}

MESH_MODELS = {"mesh_models": [{"name": "a", "status": "warm"}, {"name": "b", "status": "cold"},
                               {"name": "c", "status": "warm"}]}


class Pool(unittest.TestCase):
    def service(self, payload, path=None, chunked=False):
        tmp = tempfile.mkdtemp(prefix="shep-pool-")
        self.addCleanup(shutil.rmtree, tmp, True)
        service = FakeHTTP({"/monitor": reply(payload, chunked=chunked) if payload is not None else None},
                           path or os.path.join(tmp, "monitor.sock"))
        self.addCleanup(service.close)
        return service

    def test_the_pool_reads_headroom_per_window_and_hides_who(self):
        service = self.service(POOL)
        with mock.patch.dict(os.environ, {"SHEPHERDR_UNDERCLASS_MONITOR": service.path}):
            read = machine.underclass()
        self.assertEqual(read["state"], "ok")
        self.assertEqual(read["windows"], POOL_WINDOWS)
        self.assertEqual(read["accounts"], POOL_ACCOUNTS)
        # Codex's usable accounts' resets only: 2 + 1, never the failed account's 5.
        self.assertEqual(read["banked_resets"], 3)
        text = json.dumps(read)
        for private in ("label", '"id"', "person@example.invalid", "second@example.invalid", "claude@example.invalid",
                        "off@example.invalid", "bad@example.invalid", "go@example.invalid", "acct-"):
            self.assertNotIn(private, text)

    def test_a_chunked_monitor_answer_is_read_too(self):
        service = self.service(POOL, chunked=True)
        with mock.patch.dict(os.environ, {"SHEPHERDR_UNDERCLASS_MONITOR": service.path}):
            read = machine.underclass()
        self.assertEqual(read["state"], "ok")
        self.assertEqual(read["windows"], POOL_WINDOWS)

    def test_windows_read_shortest_first_whatever_account_reports_them(self):
        service = self.service({"accounts": [
            {"backend": "claude", "status": "healthy", "observation": {"seven_day": {"utilization": 0.5, "resets_at_ms": 2}}},
            {"backend": "claude", "status": "healthy", "observation": {"five_hour": {"utilization": 0.1, "resets_at_ms": 1}}}]})
        with mock.patch.dict(os.environ, {"SHEPHERDR_UNDERCLASS_MONITOR": service.path}):
            read = machine.underclass()
        self.assertEqual([(w["name"], w["used"]) for w in read["windows"]],
                         [("Claude · 5-hour", 10.0), ("Claude · Weekly", 50.0)])

    def test_a_tie_on_used_takes_the_account_that_frees_first(self):
        # Live: two Codex accounts both at 100% weekly. The earlier reset is when the pool frees up;
        # a third account at the same 100% but with no reset time can't say when, so it loses.
        service = self.service({"accounts": [
            {"backend": "codex", "status": "cooling",
             "quota": {"rate_limit": {"primary_window": {"used_percent": 100.0, "reset_at": 1795551869, "limit_window_seconds": 604800}}}},
            {"backend": "codex", "status": "cooling",
             "quota": {"rate_limit": {"primary_window": {"used_percent": 100.0, "reset_at": 1795000000, "limit_window_seconds": 604800}}}},
            {"backend": "codex", "status": "cooling",
             "quota": {"rate_limit": {"primary_window": {"used_percent": 100.0, "limit_window_seconds": 604800}}}}]})
        with mock.patch.dict(os.environ, {"SHEPHERDR_UNDERCLASS_MONITOR": service.path}):
            read = machine.underclass()
        self.assertEqual(read["windows"], [{"name": "Codex · Weekly", "used": 100.0, "resets_at": 1795000000000}])

    def test_a_lower_used_wins_whatever_its_reset(self):
        service = self.service({"accounts": [
            {"backend": "codex", "status": "cooling",
             "quota": {"rate_limit": {"primary_window": {"used_percent": 100.0, "reset_at": 1795000000, "limit_window_seconds": 604800}}}},
            {"backend": "codex", "status": "healthy",
             "quota": {"rate_limit": {"primary_window": {"used_percent": 40.0, "reset_at": 1799000000, "limit_window_seconds": 604800}}}}]})
        with mock.patch.dict(os.environ, {"SHEPHERDR_UNDERCLASS_MONITOR": service.path}):
            read = machine.underclass()
        self.assertEqual(read["windows"], [{"name": "Codex · Weekly", "used": 40.0, "resets_at": 1799000000000}])

    def test_no_monitor_here_is_no_key(self):
        tmp = tempfile.mkdtemp(prefix="shep-pool-")
        self.addCleanup(shutil.rmtree, tmp, True)
        env = {"SHEPHERDR_UNDERCLASS_MONITOR": os.path.join(tmp, "monitor.sock"),
               "SHEPHERDR_MESH_CONSOLE": "http://127.0.0.1:%d" % free_port()}
        with mock.patch.dict(os.environ, env), mock.patch.object(machine, "claude", lambda: None), \
                mock.patch.object(machine, "codex", lambda: None):
            self.assertIsNone(machine.underclass())
            self.assertEqual(machine.limits(), {})

    def test_a_monitor_that_fails_is_unknown(self):
        service = FakeHTTP({"/monitor": reply({"error": "no"}, "500 Internal Server Error")}, self.service_path())
        self.addCleanup(service.close)
        with mock.patch.dict(os.environ, {"SHEPHERDR_UNDERCLASS_MONITOR": service.path}):
            read = machine.underclass()
        self.assertEqual(read["state"], "unknown")
        self.assertIn("500", read["why"])

    def test_a_monitor_that_never_answers_times_out(self):
        service = FakeHTTP({"/monitor": None}, self.service_path())
        self.addCleanup(service.close)
        with mock.patch.dict(os.environ, {"SHEPHERDR_UNDERCLASS_MONITOR": service.path}):
            started = time.monotonic()
            read = machine.underclass()
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(read["state"], "unknown")
        self.assertIn("answered nothing", read["why"])

    def service_path(self):
        tmp = tempfile.mkdtemp(prefix="shep-pool-")
        self.addCleanup(shutil.rmtree, tmp, True)
        return os.path.join(tmp, "monitor.sock")

    def test_the_limits_read_carries_the_pool_beside_no_clis(self):
        service = self.service(POOL)
        env = {"SHEPHERDR_UNDERCLASS_MONITOR": service.path,
               "SHEPHERDR_MESH_CONSOLE": "http://127.0.0.1:%d" % free_port()}
        with mock.patch.dict(os.environ, env), mock.patch.object(machine, "claude", lambda: None), \
                mock.patch.object(machine, "codex", lambda: None):
            limits = machine.limits()
        self.assertEqual(list(limits), ["underclass"])
        self.assertEqual(limits["underclass"]["windows"], POOL_WINDOWS)
        self.assertTrue(limits["underclass"]["at"])


class Mesh(unittest.TestCase):
    def service(self, routes):
        service = FakeHTTP(routes)
        self.addCleanup(service.close)
        return service

    def test_a_console_is_a_mesh_read_without_its_token(self):
        service = self.service({"/api/status": reply(MESH_STATUS), "/api/models": reply(MESH_MODELS)})
        tmp = tempfile.mkdtemp(prefix="shep-pool-")
        self.addCleanup(shutil.rmtree, tmp, True)
        env = {"SHEPHERDR_MESH_CONSOLE": service.base,
               "SHEPHERDR_UNDERCLASS_MONITOR": os.path.join(tmp, "monitor.sock")}
        with mock.patch.dict(os.environ, env), mock.patch.object(machine, "claude", lambda: None), \
                mock.patch.object(machine, "codex", lambda: None):
            read = machine.mesh()
            limits = machine.limits()
        self.assertEqual(read, {"state": "ok", "windows": [], "plan": "serving",
                                "mesh": {"version": "0.72.2", "peers": 3,
                                         "serving": ["Qwen3.8-27B", "diffusiongemma"], "models": 2}})
        text = json.dumps(read)
        self.assertNotIn("token", text)
        self.assertNotIn("not-for-you", text)
        self.assertEqual(list(limits), ["mesh"])
        self.assertEqual(limits["mesh"]["plan"], "serving")
        self.assertTrue(limits["mesh"]["at"])

    def test_no_console_here_is_no_key(self):
        with mock.patch.dict(os.environ, {"SHEPHERDR_MESH_CONSOLE": "http://127.0.0.1:%d" % free_port()}):
            self.assertIsNone(machine.mesh())

    def test_a_console_that_fails_is_unknown(self):
        service = self.service({"/api/status": reply({"error": "no"}, "500 Internal Server Error")})
        with mock.patch.dict(os.environ, {"SHEPHERDR_MESH_CONSOLE": service.base}):
            read = machine.mesh()
        self.assertEqual(read["state"], "unknown")
        self.assertIn("console", read["why"])


if __name__ == "__main__":
    unittest.main()
