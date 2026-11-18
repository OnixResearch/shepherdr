"""onix: Claude Code and Codex through the Underclass pool (the Everywhere setting `onix.underclass`).

An agent sent through Underclass asks the pool's proxy instead of its own sign-in. Claude Code gets
the proxy's address and an apiKeyHelper in its --settings; Codex gets a model provider of its own
(`-c model_provider=...`) on the proxy's Responses API. Each reads the proxy key when it needs it
from `herdr-task underclass-key`, run on its own machine, so the key is never in an argv, a
template, a task record or a settings file. core/agents.js builds the same flags for the agents the
window and the web start.

Settings (Shepherdr settings' `onix`):
  underclass          the CLIs sent through it, Everywhere's: ["claude", "codex"] (default: none)
  underclass_url      its address, Everywhere's (default http://127.0.0.1:8080, Underclass's own)
  underclass_key_cmd  a shell command printing the proxy key, this machine's or Everywhere's;
                      default: omp's own Underclass provider (its extension's provider.json apiKey:
                      "!<command>" is run, anything else is the key itself)
"""

import json
import os
import re
import subprocess
import sys

from .base import Fail
from .settings import LOCAL_MACHINE, read_settings

CLIS = ("claude", "codex")
DEFAULT_URL = "http://127.0.0.1:8080"
KEY_HELPER = ("herdr-task", "underclass-key")
PROVIDER = "underclass"  # Codex's model_provider id for the pool
OMP_PROVIDER = os.path.join("~", ".omp", "agent", "extensions", "underclass", "provider.json")
KEY_TIMEOUT = 30  # seconds: the key may come over ssh from the machine that runs the pool


def _onix(layer):
    part = layer.get("onix") if isinstance(layer, dict) else None
    return part if isinstance(part, dict) else {}


def clis(d=None):
    """The CLIs Everywhere's onix.underclass sends through the pool, known ones only."""
    d = read_settings() if d is None else d
    raw = _onix(d.get("everywhere")).get("underclass")
    names = {str(x).strip().lower() for x in raw} if isinstance(raw, list) else set()
    return [c for c in CLIS if c in names]


def url(d=None):
    """The pool's address: Everywhere's onix.underclass_url when it is an http(s) URL, else Underclass's default."""
    d = read_settings() if d is None else d
    raw = _onix(d.get("everywhere")).get("underclass_url")
    raw = raw.strip() if isinstance(raw, str) else ""
    return (raw if re.match(r"https?://", raw) else DEFAULT_URL).rstrip("/")


def routed(agent, d=None):
    """The pool's address when `agent` (claude, codex) goes through Underclass, else None."""
    d = read_settings() if d is None else d
    return url(d) if agent in clis(d) else None


def claude_settings(base):
    """Claude Code's --settings keys that send it through the pool at `base`."""
    return {"apiKeyHelper": " ".join(KEY_HELPER), "env": {"ANTHROPIC_BASE_URL": base.rstrip("/")}}


def codex_args(base):
    """Codex's -c overrides that send it through the pool at `base` (its Responses API, the key by command)."""
    api = json.dumps(base.rstrip("/") + "/v1")
    auth = '{command="%s",args=["%s"]}' % KEY_HELPER
    return ["-c", f'model_provider="{PROVIDER}"',
            "-c", f'model_providers.{PROVIDER}={{name="Underclass",base_url={api},wire_api="responses",auth={auth}}}']


# ---- the proxy key, read on the agent's own machine ---------------------------------------------

def key_source(d=None):
    """(shell command, literal key) for this machine's proxy key; both None when there is none.
    onix.underclass_key_cmd (this machine's, then Everywhere's) first, else omp's own provider."""
    d = read_settings() if d is None else d
    machine = (d.get("machines") or {}).get(d.get("here") or LOCAL_MACHINE)
    for layer in (machine, d.get("everywhere")):
        cmd = _onix(layer).get("underclass_key_cmd")
        if isinstance(cmd, str) and cmd.strip():
            return cmd.strip(), None
    try:
        with open(os.path.expanduser(OMP_PROVIDER)) as f:
            key = (json.load(f) or {}).get("apiKey")
    except (OSError, ValueError, AttributeError):
        return None, None
    if not isinstance(key, str) or not key.strip():
        return None, None
    key = key.strip()
    return (key[1:].strip(), None) if key.startswith("!") else (None, key)


def proxy_key(d=None):
    """The pool's proxy key on this machine. Refused with why (never with what a command printed:
    that could be the key)."""
    cmd, literal = key_source(d)
    if literal:
        return literal
    if not cmd:
        raise Fail("no Underclass key here: set onix.underclass_key_cmd in Shepherdr's settings, "
                   f"or set up omp's underclass provider ({OMP_PROVIDER})")
    try:
        r = subprocess.run(["sh", "-c", cmd], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, universal_newlines=True, timeout=KEY_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise Fail(f"the Underclass key command took longer than {KEY_TIMEOUT}s")
    except OSError as e:
        raise Fail(f"couldn't run the Underclass key command ({e.strerror or e})")
    key = (r.stdout or "").strip()
    if r.returncode != 0 or not key or "\n" in key:
        raise Fail(f"the Underclass key command gave no key (exit {r.returncode})")
    return key


def cmd_underclass_key(args):
    """`herdr-task underclass-key`: prints the proxy key, for Claude Code's apiKeyHelper and Codex's
    provider auth command. Nothing else ever prints it."""
    sys.stdout.write(proxy_key() + "\n")
    return 0
