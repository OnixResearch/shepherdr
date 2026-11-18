"""A machine's health (CPU, memory, disk) and what is left of its CLIs' plans, read on the machine
itself (HERD-40, as Shepherdr's health and plan-limits). Standalone, so it runs anywhere with
nothing installed: Herdr's sidebar sends it as `python3 -c <this file> [--limits]` through
`hc exec --on <machine>` and reads the JSON it prints, {"health": {...}, "limits": {...}}; and
herdr-task's tick imports it to hold new tasks while its machine is too busy (hold_reason).

Plan limits come only from each CLI's own usage source, each in its own short process that can
write nothing real (bwrap on Linux, sandbox-exec on a Mac): Claude Code's `/usage` and Codex's
`account/rateLimits/read`. Never through a running agent, never a guess: a CLI it can't read says
why. Only percentages, reset times, the plan's name and the signed-in account come back. Onix's pool
and mesh read their own read-only services here instead (`# onix:` below), with counts, never labels."""

import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")
MAC = sys.platform == "darwin"

# New tasks wait while the 1-minute load is over this many times the cores, or memory or the
# fullest disk (home, /tmp) is over this share (%): Shepherdr's start limits, and its disk alert.
HOLD = {"start_load": 1.0, "start_memory": 80, "start_disk": 90}
# Past these the sidebar's meter turns red (Shepherdr's alert limits).
ALERT = {"load": 1.5, "memory": 90, "disk": 90}


# ---- health -------------------------------------------------------------------------------------

def _run(argv, timeout=10):
    try:
        return subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True,
                              timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _memory():
    """(total, in use) in bytes: in use is what isn't available."""
    if not MAC:
        with open("/proc/meminfo") as f:
            text = f.read()

        def kb(name):
            m = re.search(r"^%s:\s+(\d+)" % name, text, re.M)
            return int(m.group(1)) * 1024 if m else 0
        total = kb("MemTotal")
        return total, max(0, total - (kb("MemAvailable") or kb("MemFree")))
    total = int(_run(["sysctl", "-n", "hw.memsize"]).strip() or 0)
    # macOS's own free share (kern.memorystatus_level: the figure memory_pressure prints) counts the
    # cache it can take back as free, which a sum of vm_stat's pages doesn't (SHEP-199, #922).
    level = _run(["sysctl", "-n", "kern.memorystatus_level"]).strip()
    if total and level.isdigit():
        return total, total * (100 - min(100, int(level))) // 100
    vm = _run(["vm_stat"])
    page = int((re.search(r"page size of (\d+)", vm) or [0, 4096])[1])

    def pages(name):
        m = re.search(r"^%s:\s+(\d+)" % re.escape(name), vm, re.M)
        return int(m.group(1)) * page if m else 0
    free = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")
    return total, max(0, total - free) if total else 0


def _disks():
    """Home and /tmp, once each when they're one disk: % full as df counts it (used over what an
    ordinary user could have)."""
    out, seen = [], set()
    for path in (HOME, "/tmp"):
        try:
            st, dev = os.statvfs(path), os.stat(path).st_dev
        except OSError:
            continue
        if dev in seen:
            continue
        seen.add(dev)
        used = (st.f_blocks - st.f_bfree) * st.f_frsize
        avail = st.f_bavail * st.f_frsize
        if used + avail <= 0:
            continue
        out.append({"path": "home" if path == HOME else path, "pct": round(used * 100 / (used + avail)),
                    "free_gb": round(avail / 2 ** 30)})
    return out


def sample():
    """{at, cores, load, cpu, mem_total, mem_used, memory, disk, disks}: cpu is the 1-minute load
    over the cores (%), memory in use (%), disk the fullest (%)."""
    cores = os.cpu_count() or 1
    load = os.getloadavg()[0]
    total, used = _memory()
    disks = _disks()
    return {"at": int(time.time() * 1000), "cores": cores, "load": round(load, 2), "cpu": round(load * 100 / cores),
            "mem_total": total, "mem_used": used, "memory": round(used * 100 / total) if total else 0,
            "disk": max([d["pct"] for d in disks] or [0]), "disks": disks}


def hold_limits(given=None):
    """The start limits, from `given` (Settings' for this machine) over Shepherdr's defaults. A
    limit set to None is off."""
    out = dict(HOLD)
    for k, v in (given or {}).items():
        if k in out:
            out[k] = v
    return out


def hold_reason(h, limits=None):
    """Why new tasks wait on this machine, in plain words ("memory is 92% full"), or None when
    there's room."""
    lim = hold_limits(limits)
    if lim["start_memory"] is not None and h["memory"] > lim["start_memory"]:
        return "memory is %d%% full" % h["memory"]
    if lim["start_load"] is not None and h["load"] > lim["start_load"] * h["cores"]:
        return "CPU is %d%% busy" % h["cpu"]
    if lim["start_disk"] is not None and h["disk"] > lim["start_disk"]:
        return "disk is %d%% full" % h["disk"]
    return None


# ---- plan limits --------------------------------------------------------------------------------
# A read is {"state": "ok", "windows": [{name, used, resets_at?, resets?}], "plan"?, "account"?},
# {"state": "signed-out" | "no-plan"} or {"state": "unknown", "why"}. A CLI not here is left out.

SOON = 3600 * 1000
WEEK = 7 * 86400 * 1000
DUE = {"state": "unknown", "why": "Its sign-in is due for renewal: the next agent here will do it"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
PATHS = [os.path.join(HOME, ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin", os.path.join(HOME, ".npm-global", "bin"),
         os.path.join(HOME, ".bun", "bin"), os.path.join(HOME, ".claude", "local")]


def now_ms():
    return int(time.time() * 1000)


def which(name):
    """The CLI's real program: hc exec's PATH is short, and a mise wrapper can't start sealed."""
    path = os.pathsep.join([os.environ.get("PATH", "")] + PATHS)
    found = shutil.which(name, path=path)
    if found and "/mise/" in found and ("/shims/" in found or "/command-wrappers/" in found):
        mise = shutil.which("mise", path=path)
        real = _run([mise, "which", name]).strip() if mise else ""
        found = real if real and os.path.exists(real) else found
    return found


def _quiet(argv):
    return (["nice", "-n", "19"] if shutil.which("nice") else []) + argv


def _seal(argv, over=None):
    """bwrap: the whole machine read-only, /tmp empty. `over`: (throwaway folder, the CLI's own
    folder it stands in for, the real files kept visible in it)."""
    extra = []
    if over:
        folder, home, kept = over
        extra = ["--bind", folder, home] + [x for p in kept for x in ("--ro-bind", p, p)]
    return ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--share-net",
            "--die-with-parent"] + extra + ["--chdir", "/tmp", "--"] + argv


MAC_PROFILE = """(version 1)
(allow default)
(deny file-write*)
(deny user-preference-write)
(deny process-exec (literal "/usr/bin/security"))
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))
(allow file-write* (subpath (param "OPEN")))
(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty"))"""
SANDBOX = "/usr/bin/sandbox-exec"


def _mac_seal():
    """A throwaway folder shown sealed by a real run first: (open folder, wrap, close), or None."""
    folder = os.path.realpath(tempfile.mkdtemp(prefix="herdr-limits-"))
    opened, shut = os.path.join(folder, "open"), os.path.join(folder, "shut")
    os.mkdir(opened)
    os.mkdir(shut)

    def wrap(argv):
        return [SANDBOX, "-p", MAC_PROFILE, "-DOPEN=" + opened, "--"] + argv

    def close():
        shutil.rmtree(folder, ignore_errors=True)
    proof = '/usr/bin/touch "$1/proof" && ! /usr/bin/touch "$2/proof" 2>/dev/null && ! /usr/bin/security list-keychains >/dev/null 2>&1'
    try:
        code = subprocess.run(wrap(["/bin/sh", "-c", proof, "proof", opened, shut]), stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=10).returncode
    except (OSError, subprocess.SubprocessError):
        code = 1
    if code == 0 and os.path.exists(os.path.join(opened, "proof")) and not os.path.exists(os.path.join(shut, "proof")):
        return opened, wrap, close
    close()
    return None


def _no_seal():
    if MAC:
        return None if os.path.exists(SANDBOX) else "Can't read it safely here: sandbox-exec is missing"
    return None if shutil.which("bwrap") or os.path.exists("/usr/bin/bwrap") else "Can't read it safely here: bwrap is missing"


def claude_reset(words, at):
    """ "Nov 6, 11:59am (UTC)" or "3pm (UTC)": the next such moment (ms)."""
    import calendar
    m = re.match(r"^(?:([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))?(?:,| at)? )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?: \(UTC\))?$", words, re.I)
    if not m:
        return None
    if m.group(1) and m.group(1) not in MONTHS:
        return None
    ampm = (m.group(6) or "").lower()
    hour = int(m.group(4)) % (12 if ampm else 24) + (12 if ampm == "pm" else 0)
    minute = int(m.group(5) or 0)
    today = time.gmtime(at / 1000)
    if not m.group(1):
        t = calendar.timegm((today.tm_year, today.tm_mon, today.tm_mday, hour, minute, 0)) * 1000
        return t + 86400000 if t + 60000 <= at else t

    def on(year):
        return calendar.timegm((year, MONTHS.index(m.group(1)) + 1, int(m.group(2)), hour, minute, 0)) * 1000
    if m.group(3):
        return on(int(m.group(3)))
    return on(today.tm_year + 1) if on(today.tm_year) < at - 86400000 else on(today.tm_year)


def parse_claude(text, at):
    """What /usage printed: `Current week (all models): 10% used · resets Nov 6, 11:59am (UTC)`."""
    windows = []
    for line in text.split("\n"):
        m = re.match(r"^(.+?): (\d+(?:\.\d+)?)% used(?: · resets (.+))?$", line.strip())
        if not m:
            continue
        name = re.sub(r"^Current week\b", "Weekly", re.sub(r"^Current session\b", "5-hour", m.group(1)))[:60]
        w = {"name": name, "used": float(m.group(2))}
        if m.group(3):
            r = claude_reset(m.group(3), at)
            if r:
                w["resets_at"] = r
            else:
                w["resets"] = m.group(3)[:60]
        windows.append(w)
    if windows:
        return {"state": "ok", "windows": windows}
    if re.search(r"not logged in|/login", text, re.I):
        return {"state": "signed-out"}
    if re.search(r"^Total cost:", text, re.M):
        return {"state": "no-plan"}
    return {"state": "unknown", "why": "Claude Code's answer had no limits in it"}


def _json_file(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _claude_due(login, at):
    end = ((login or {}).get("claudeAiOauth") or {}).get("expiresAt")
    return end is not None and not (end - SOON > at)


def _ask_claude(argv, env, cwd=None):
    try:
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           universal_newlines=True, env=env, cwd=cwd, timeout=60)
    except subprocess.TimeoutExpired:
        return {"state": "unknown", "why": "Claude Code took too long to answer"}
    try:
        result = json.loads(r.stdout).get("result")
    except (ValueError, AttributeError):
        result = None
    if not isinstance(result, str):
        return {"state": "unknown", "why": "Couldn't read Claude Code's answer"}
    return parse_claude(result, now_ms())


def claude():
    binary = which("claude")
    if not binary:
        return None
    missing = _no_seal()
    if missing:
        return {"state": "unknown", "why": missing}
    config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
    if not os.path.isdir(config):
        return {"state": "signed-out"}
    login = _json_file(os.path.join(config, ".credentials.json"))
    oauth = (login or {}).get("claudeAiOauth") or {}
    extra = {}
    if oauth.get("subscriptionType"):
        extra["plan"] = str(oauth["subscriptionType"])[:30]
    account = ((_json_file(os.path.join(HOME, ".claude.json")) or {}).get("oauthAccount") or {}).get("emailAddress")
    if account:
        extra["account"] = str(account)[:80]
    command = _quiet([binary, "-p", "/usage", "--output-format", "json", "--no-session-persistence",
                      "--setting-sources", "", "--strict-mcp-config"])
    if not MAC:
        if login is not None and _claude_due(login, now_ms()):
            return DUE
        got = _ask_claude(_seal(command), dict(os.environ, TZ="UTC", TMPDIR="/tmp"))
        return dict(got, **extra) if got["state"] == "ok" else got
    # A Mac keeps the login in the Keychain (and maybe the file): the CLI gets that login, without
    # its way to renew, in a throwaway folder, and the Keychain stays out of reach.
    keychain = None
    user = os.environ.get("USER") or "claude-code-user"
    try:
        r = subprocess.run(["/usr/bin/security", "find-generic-password", "-a", user, "-w", "-s", "Claude Code-credentials"],
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           universal_newlines=True, timeout=5)
        if r.returncode == 0:
            keychain = json.loads(r.stdout.strip())
        elif r.returncode != 44:
            return {"state": "unknown", "why": "Couldn't check its sign-in in the Keychain, so it wasn't run"}
    except (OSError, subprocess.SubprocessError, ValueError):
        return {"state": "unknown", "why": "Couldn't check its sign-in in the Keychain, so it wasn't run"}
    held = keychain if keychain and keychain.get("claudeAiOauth") else login
    if held is not None and _claude_due(held, now_ms()):
        return DUE
    seal = _mac_seal()
    if not seal:
        return {"state": "unknown", "why": "Can't read it safely here: the Mac seal wouldn't hold"}
    opened, wrap, close = seal
    try:
        state, bin_dir = os.path.join(opened, "claude"), os.path.join(opened, "bin")
        os.mkdir(state, 0o700)
        os.mkdir(bin_dir, 0o700)
        with open(os.path.join(bin_dir, "security"), "w") as f:
            f.write("#!/bin/sh\nexit 44\n")
        os.chmod(os.path.join(bin_dir, "security"), 0o700)
        if held and held.get("claudeAiOauth"):
            sealed = {k: v for k, v in held["claudeAiOauth"].items() if k != "refreshToken"}
            fd = os.open(os.path.join(state, ".credentials.json"), os.O_WRONLY | os.O_CREAT, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump({"claudeAiOauth": sealed}, f)
        env = dict(os.environ, CLAUDE_CONFIG_DIR=state, PATH=bin_dir + ":" + os.environ.get("PATH", ""), TZ="UTC", TMPDIR=opened)
        env.pop("CLAUDE_SECURESTORAGE_CONFIG_DIR", None)
        got = _ask_claude(wrap(command), env, cwd=opened)
        return dict(got, **extra) if got["state"] == "ok" else got
    finally:
        close()


def _window_name(minutes):
    if minutes == 300:
        return "5-hour"
    if minutes == 10080:
        return "Weekly"
    if not isinstance(minutes, (int, float)) or minutes <= 0:
        return "Limit"
    if minutes % 1440 == 0:
        return "%d-day" % (minutes // 1440)
    if minutes % 60 == 0:
        return "%d-hour" % (minutes // 60)
    return "%d-minute" % minutes


def parse_codex(result):
    """account/rateLimits/read's answer. A limit of its own (one model's) says so before its name."""
    result = result or {}
    snaps = list((result.get("rateLimitsByLimitId") or {}).values())
    if not snaps and result.get("rateLimits"):
        snaps = [result["rateLimits"]]
    snaps.sort(key=lambda s: s.get("limitId") != "codex")
    windows = []
    for s in snaps:
        for w in (s.get("primary"), s.get("secondary")):
            if not isinstance((w or {}).get("usedPercent"), (int, float)):
                continue
            named = s.get("limitName") if s.get("limitId") != "codex" and isinstance(s.get("limitName"), str) else ""
            x = {"name": (named[:40] + " · " if named else "") + _window_name(w.get("windowDurationMins")), "used": w["usedPercent"]}
            if isinstance(w.get("resetsAt"), (int, float)):
                x["resets_at"] = int(w["resetsAt"] * 1000)
            windows.append(x)
    plan = next((s.get("planType") for s in snaps if isinstance(s.get("planType"), str) and s.get("planType") != "unknown"), None)
    if not windows:
        return {"state": "unknown", "why": "Codex reported no limits"}
    return dict({"state": "ok", "windows": windows}, **({"plan": plan[:30]} if plan else {}))


def _codex_due(auth, at):
    import base64
    try:
        if not auth.get("tokens"):
            return False
        part = auth["tokens"]["access_token"].split(".")[1]
        end = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))["exp"] * 1000
        last = auth.get("last_refresh") or ""
        import datetime
        refreshed = datetime.datetime.strptime(last[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000
        return not (end - SOON > at and at - refreshed < WEEK)
    except Exception:
        return True


def _ask_codex(argv, env=None, cwd=None):
    try:
        p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             universal_newlines=True, env=env, cwd=cwd)
    except OSError:
        return {"state": "unknown", "why": "Couldn't run it"}
    timer = threading.Timer(30, p.kill)
    timer.start()
    try:
        for m in ({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "herdr", "title": "Herdr", "version": "1"}}},
                  {"method": "initialized"}, {"id": 2, "method": "account/read", "params": {"refreshToken": False}},
                  {"id": 3, "method": "account/rateLimits/read"}):
            p.stdin.write(json.dumps(m) + "\n")
        p.stdin.flush()
        extra = {}
        for line in p.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("id") == 2:
                acct = (msg.get("result") or {}).get("account")
                if msg.get("error") or not acct:
                    return {"state": "signed-out"}
                if acct.get("type") == "apiKey":
                    return {"state": "no-plan"}
                if acct.get("planType") and acct["planType"] != "unknown":
                    extra["plan"] = str(acct["planType"])[:30]
                if acct.get("email"):
                    extra["account"] = str(acct["email"])[:80]
            if msg.get("id") == 3:
                if msg.get("error"):
                    if re.search(r"auth|log ?in|sign", (msg["error"] or {}).get("message") or "", re.I):
                        return {"state": "signed-out"}
                    return {"state": "unknown", "why": "This Codex can't report its limits"}
                got = parse_codex(msg.get("result"))
                return dict(extra, **got) if got["state"] == "ok" else got
        return {"state": "unknown", "why": "Codex took too long to answer" if not timer.is_alive() else "Codex stopped before answering"}
    finally:
        timer.cancel()
        try:
            p.kill()
        except OSError:
            pass


def codex():
    binary = which("codex")
    if not binary:
        return None
    missing = _no_seal()
    if missing:
        return {"state": "unknown", "why": missing}
    home = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
    if not os.path.isdir(home):
        return {"state": "signed-out"}
    login = os.path.join(home, "auth.json")
    if os.path.exists(login) and _codex_due(_json_file(login) or {}, now_ms()):
        return DUE
    kept = [p for p in (login, os.path.join(home, "config.toml")) if os.path.exists(p)]
    if not MAC:
        # Codex won't start without its own databases, so it gets empty ones.
        folder = tempfile.mkdtemp(prefix="herdr-limits-")
        try:
            return _ask_codex(_seal(_quiet([binary, "app-server", "--disable", "plugins"]), (folder, home, kept)))
        finally:
            shutil.rmtree(folder, ignore_errors=True)
    if not os.path.exists(login):
        return {"state": "unknown", "why": "No Codex sign-in file here to check, so it wasn't run"}
    seal = _mac_seal()
    if not seal:
        return {"state": "unknown", "why": "Can't read it safely here: the Mac seal wouldn't hold"}
    opened, wrap, close = seal
    try:
        state = os.path.join(opened, "codex")
        os.mkdir(state, 0o700)
        for p in kept:
            os.symlink(os.path.realpath(p), os.path.join(state, os.path.basename(p)))
        env = dict(os.environ, CODEX_HOME=state, CODEX_SQLITE_HOME=state, TMPDIR=opened)
        if os.path.exists("/etc/ssl/cert.pem"):
            env["SSL_CERT_FILE"] = "/etc/ssl/cert.pem"
        argv = _quiet([binary, "app-server", "--disable", "plugins", "-c", 'cli_auth_credentials_store="file"'])
        return _ask_codex(wrap(argv), env, cwd=opened)
    finally:
        close()


# ---- pool and mesh (onix: Underclass's pool and mesh-llm, when they run on this machine) ---------
# Read here, never through an agent: Underclass's monitor socket (tokenless, read-only) and mesh-llm's
# console. Neither is a CLI, so neither needs bwrap; both are optional (no service, no key), and the
# reads carry counts and names only: no label, email, account id or token ever comes back.

POOL_SOCKET = "/run/underclass/monitor.sock"
MESH_CONSOLE = "http://127.0.0.1:3131"
SERVICE_TIMEOUT = 3
# The pool's backends, in the order its monitor lists people's accounts; names as the plan rows say them.
POOL_ORDER = ["codex", "claude", "opencode-go", "copilot"]
POOL_NAMES = {"codex": "Codex", "claude": "Claude", "opencode-go": "OpenCode Go", "copilot": "Copilot"}
# An account that can't serve now still counts in `accounts`, never in the headroom.
POOL_OFF = ("disabled", "auth_error")
OBSERVATION_WINDOWS = [("five_hour", "5-hour"), ("seven_day", "Weekly"), ("seven_day_fable", "Weekly (Fable)"),
                       ("monthly", "Monthly")]
# Windows read in this order within a backend (the shortest first), wherever they were first seen.
WINDOW_ORDER = ["5-hour", "Weekly", "Weekly (Fable)", "Monthly", "Primary", "Secondary"]
_MISSING = (FileNotFoundError, ConnectionRefusedError, NotADirectoryError)


class _UnixHTTP(http.client.HTTPConnection):
    """An HTTP connection over a unix socket: http.client has no client for one, and this file must
    stay standalone (stdlib only)."""

    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.unix_path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.unix_path)


def _web_get(url, timeout=SERVICE_TIMEOUT):
    """The body of an HTTP GET (bytes); an absent service and a failure both raise."""
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as answer:
        return answer.read()


def _backend(account):
    return str(account.get("backend") or "").strip().lower().replace("_", "-") or "unknown"


def _account_windows(account):
    """[(window name, % used, reset ms or None)]: Codex's quota windows, then Claude's and OpenCode Go's
    observation windows (a 0..1 fraction there, a percentage in Codex's quota)."""
    out = []
    quota = account.get("quota") if isinstance(account.get("quota"), dict) else {}
    rate = quota.get("rate_limit") if isinstance(quota.get("rate_limit"), dict) else {}
    for key, fallback in (("primary_window", "Primary"), ("secondary_window", "Secondary")):
        window = rate.get(key) if isinstance(rate.get(key), dict) else {}
        used = window.get("used_percent")
        if not isinstance(used, (int, float)):
            continue
        seconds = window.get("limit_window_seconds")
        name = _window_name(int(seconds) // 60) if isinstance(seconds, (int, float)) and seconds > 0 else fallback
        reset = window.get("reset_at")
        out.append((name, float(used), int(reset * 1000) if isinstance(reset, (int, float)) else None))
    observation = account.get("observation") if isinstance(account.get("observation"), dict) else {}
    for key, name in OBSERVATION_WINDOWS:
        window = observation.get(key) if isinstance(observation.get(key), dict) else {}
        used = window.get("utilization")
        if not isinstance(used, (int, float)):
            continue
        reset = window.get("resets_at_ms")
        out.append((name, round(float(used) * 100, 1), int(reset) if isinstance(reset, (int, float)) else None))
    return out


def pool_read(payload):
    """The monitor's accounts as a read: for each backend and window kind, the headroom of its best
    usable account (the lowest % used, and that account's reset): the pool, not its worst account."""
    accounts = payload.get("accounts") if isinstance(payload, dict) else None
    if not isinstance(accounts, list):
        return {"state": "unknown", "why": "Its monitor had no accounts in it"}
    best, order = {}, []
    listed, banked = [], 0
    for account in accounts:
        if not isinstance(account, dict):
            continue
        backend = _backend(account)
        status = str(account.get("status") or "unknown")[:20]
        quota = account.get("quota") if isinstance(account.get("quota"), dict) else {}
        observation = account.get("observation") if isinstance(account.get("observation"), dict) else {}
        resets = quota.get("available_resets")
        if not isinstance(resets, (int, float)):
            resets = observation.get("reset_credits")
        row = {"backend": backend, "status": status}
        if isinstance(account.get("plan"), str) and account["plan"]:
            row["plan"] = str(account["plan"])[:20]
        if isinstance(resets, (int, float)):
            row["resets"] = int(resets)
        listed.append(row)
        if status in POOL_OFF:
            continue
        if backend == "codex" and isinstance(resets, (int, float)):
            banked += int(resets)
        for name, used, reset in _account_windows(account):
            key = (backend, name)
            if key not in best:
                order.append(key)
                best[key] = (used, reset)
            elif used < best[key][0]:
                best[key] = (used, reset)
    rank = {b: i for i, b in enumerate(POOL_ORDER)}
    rank_of = {name: i for i, name in enumerate(WINDOW_ORDER)}
    order.sort(key=lambda k: (rank.get(k[0], len(rank)), rank_of.get(k[1], len(rank_of))))
    windows = []
    for backend, name in order:
        used, reset = best[(backend, name)]
        window = {"name": "%s · %s" % (POOL_NAMES.get(backend, backend.title()), name), "used": used}
        if reset is not None:
            window["resets_at"] = reset
        windows.append(window)
    return {"state": "ok", "windows": windows, "accounts": listed, "banked_resets": banked}


def underclass():
    """Underclass's pool, from its monitor socket here: None when this machine has no monitor."""
    path = os.environ.get("SHEPHERDR_UNDERCLASS_MONITOR") or POOL_SOCKET
    try:
        if not os.path.exists(path):
            return None
    except OSError:
        return None
    conn = _UnixHTTP(path, SERVICE_TIMEOUT)
    try:
        conn.request("GET", "/monitor", headers={"Accept": "application/json"})
        answer = conn.getresponse()
        body = answer.read()
        if answer.status != 200:
            return {"state": "unknown", "why": "Its monitor answered HTTP %d" % answer.status}
    except _MISSING:
        return None
    except (socket.timeout, TimeoutError):
        return {"state": "unknown", "why": "Its monitor answered nothing in %d s" % SERVICE_TIMEOUT}
    except (OSError, http.client.HTTPException) as e:
        return {"state": "unknown", "why": "Couldn't ask its monitor: %s" % str(e or e.__class__.__name__)[:80]}
    finally:
        conn.close()
    try:
        payload = json.loads(body.decode("utf-8"))
    except ValueError:
        return {"state": "unknown", "why": "Its monitor's answer wasn't JSON"}
    return pool_read(payload)


def mesh_read(status, models=None):
    """mesh-llm's status and models as a read: who it is and what it serves, never its console token."""
    status = status if isinstance(status, dict) else {}
    mesh = {}
    if isinstance(status.get("version"), str) and status["version"]:
        mesh["version"] = status["version"][:30]
    if isinstance(status.get("peers"), (list, dict)):
        mesh["peers"] = len(status["peers"])
    serving = status.get("serving_models")
    if not isinstance(serving, list):
        serving = status.get("hosted_models")
    if isinstance(serving, list):
        names = []
        for name in serving:
            if isinstance(name, str) and name and name[:80] not in names:
                names.append(name[:80])
        mesh["serving"] = names
    rows = models.get("mesh_models") if isinstance(models, dict) else None
    if isinstance(rows, list):
        mesh["models"] = sum(1 for row in rows if isinstance(row, dict) and row.get("status") == "warm")
    read = {"state": "ok", "windows": [], "mesh": mesh}
    if isinstance(status.get("node_state"), str) and status["node_state"]:
        read["plan"] = status["node_state"][:30]
    return read


def mesh():
    """mesh-llm's console here: None when nothing answers there (no mesh on this machine)."""
    console = (os.environ.get("SHEPHERDR_MESH_CONSOLE") or MESH_CONSOLE).rstrip("/")
    try:
        body = _web_get(console + "/api/status")
    except urllib.error.URLError as e:
        if isinstance(e.reason, ConnectionRefusedError) or "refused" in str(e.reason).lower():
            return None
        if isinstance(e.reason, (socket.timeout, TimeoutError)) or "timed out" in str(e.reason).lower():
            return {"state": "unknown", "why": "Its console answered nothing in %d s" % SERVICE_TIMEOUT}
        return {"state": "unknown", "why": "Couldn't ask its console: %s" % str(e.reason)[:80]}
    except (OSError, http.client.HTTPException) as e:
        return {"state": "unknown", "why": "Couldn't ask its console: %s" % str(e or e.__class__.__name__)[:80]}
    try:
        status = json.loads(body.decode("utf-8"))
    except ValueError:
        return {"state": "unknown", "why": "Its console's answer wasn't JSON"}
    try:
        models = json.loads(_web_get(console + "/api/models").decode("utf-8"))
    except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError):
        models = None
    return mesh_read(status, models)


def limits():
    """{claude?, codex?, underclass?, mesh?}: each source here, read side by side."""
    out = {}

    def safely(key, read):
        try:
            got = read()
        except Exception:
            got = {"state": "unknown", "why": "Couldn't run it"}
        if got is not None:
            out[key] = dict(got, at=now_ms())
    jobs = [threading.Thread(target=safely, args=a)
            for a in (("claude", claude), ("codex", codex), ("underclass", underclass), ("mesh", mesh))]
    for j in jobs:
        j.start()
    for j in jobs:
        j.join()
    return out


def main(argv):
    out = {"health": sample()}
    if "--limits" in argv:
        out["limits"] = limits()
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
