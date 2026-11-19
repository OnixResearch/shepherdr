// onix: Kiln's HTTP API from this computer, as Kiln's website reaches it: over the tailnet to onix.kiln.url, where
// Kiln's proxy signs the request in by this machine's Tailscale identity, with Kiln's CA (onix.kiln.ca) when its
// certificate isn't signed by a public CA. curl does the requests: the window's fetch can't take a private CA. A
// mutation carries the website's own Origin (Kiln's proxy admits mutations only from it) and a fresh request id.
import { exec, home, readTextFile } from "herdr";
import { dirs } from "./dirs.js";
import { kilnSettings, errorText, requestId } from "./core/kiln.js";

export class KilnError extends Error {
  constructor(text, { status = 0, code = null, kind = "http" } = {}) {
    super(text);
    this.status = status;
    this.code = code;
    this.kind = kind;
  }
}

const expand = (p) => (p && p.startsWith("~/") ? `${home()}/${p.slice(2)}` : p);

// onix.kiln from Shepherdr's settings file: { url, origin, ca } (url null when Kiln isn't set up).
export async function loadSettings() {
  try {
    return kilnSettings(JSON.parse((await readTextFile(dirs().settings)) ?? "{}") ?? {});
  } catch {
    return kilnSettings({});
  }
}

// curl's exit codes worded as the website words a failed request.
function curlWhy(code, stderr) {
  if (code === 28) return "The request timed out; its result is not known.";
  if (code === 60 || code === 77 || code === 35) return "Kiln's certificate wasn't trusted: set onix.kiln.ca to Kiln's CA certificate.";
  if (code === 6 || code === 7) return "The service could not be reached. Its current state is unavailable.";
  const last = String(stderr ?? "").trim().split("\n").pop() ?? "";
  return last ? `The service could not be reached (${last.replace(/^curl: \(\d+\)\s*/, "")}).` : "The service could not be reached. Its current state is unavailable.";
}

// One request: the parsed JSON (or the text, for `text: true`), or a KilnError. GET by default; a body makes it JSON.
export async function request(cfg, path, { method = "GET", body = undefined, text = false, accept = "application/json", timeout = 30000 } = {}) {
  if (!cfg?.url) throw new KilnError("Kiln isn't set up: set onix.kiln.url in Shepherdr's settings to Kiln's website.", { kind: "setup" });
  const args = ["-sS", "--max-time", String(Math.max(1, Math.ceil(timeout / 1000))), "-H", `Accept: ${accept}`, "-w", "\n%{http_code}"];
  if (cfg.ca) args.push("--cacert", expand(cfg.ca));
  if (method !== "GET") args.push("-X", method, "-H", `Origin: ${cfg.origin}`);
  if (body !== undefined) args.push("-H", "Content-Type: application/json", "--data-raw", JSON.stringify(body));
  args.push(cfg.url + path);
  const r = await exec("curl", args, { timeout: timeout + 5000 }).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
  if (r.code !== 0) throw new KilnError(curlWhy(r.code, r.stderr), { kind: "network" });
  const out = String(r.stdout ?? "");
  const cut = out.lastIndexOf("\n");
  const status = Number(out.slice(cut + 1));
  const raw = out.slice(0, Math.max(0, cut));
  if (status >= 200 && status < 300) {
    if (text) return raw;
    try { return raw ? JSON.parse(raw) : null; } catch { throw new KilnError("The service returned invalid JSON. No state was admitted by this panel.", { status }); }
  }
  let data = null;
  try { data = JSON.parse(raw); } catch {}
  throw new KilnError(errorText(status, data), { status, code: data?.code ?? null });
}

// A mutation, as the website sends one: POST with a fresh request id (Kiln replays the same id rather than act twice).
export function mutate(cfg, path, payload) {
  const id = requestId();
  return request(cfg, path, { method: "POST", body: { ...payload, request_id: id } }).then((data) => ({ data, id }), (e) => { e.requestId = id; throw e; });
}

// GET /api/live?after=<version>: { version, runs } for a new snapshot, or null for a heartbeat (nothing moved).
export async function live(cfg, after) {
  const text = await request(cfg, `/api/live?after=${encodeURIComponent(after)}`, { text: true, accept: "text/event-stream", timeout: 15000 });
  let snapshot = null, recognised = false;
  for (const frame of String(text).split(/\n\n+/)) {
    let event = null;
    const data = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) recognised = true;
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (event === "heartbeat") recognised = true;
    if (event === "snapshot" && data.length) {
      const s = JSON.parse(data.join("\n"));
      if (!Number.isSafeInteger(s?.version) || s.version < 0 || !Array.isArray(s.runs)) throw new KilnError("The live snapshot was malformed.");
      snapshot = s;
      recognised = true;
    }
  }
  if (!recognised) throw new KilnError("The live stream sent nothing this panel recognises.");
  return snapshot;
}

// Saves what a GET returns into ~/Downloads/<name> (logs, artifacts, report sources): the file's path.
export async function download(cfg, path, name) {
  if (!cfg?.url) throw new KilnError("Kiln isn't set up.", { kind: "setup" });
  const safe = String(name || "kiln-download").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "kiln-download";
  const target = `${home()}/Downloads/${safe}`;
  const args = ["-sS", "--fail", "--max-time", "300", "-H", "Accept: application/octet-stream", "--create-dirs", "-o", target];
  if (cfg.ca) args.push("--cacert", expand(cfg.ca));
  args.push(cfg.url + path);
  const r = await exec("curl", args, { timeout: 310000 }).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
  if (r.code !== 0) throw new KilnError(r.code === 22 ? "Kiln refused the download." : curlWhy(r.code, r.stderr), { kind: "network" });
  return target;
}
