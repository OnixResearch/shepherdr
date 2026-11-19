import { expect, test } from "bun:test";
import { kilnSettings, outcomeStatus, retryBadge, formatDuration, formatRelative, dayGroups, runsQuery, errorLines, failureFirst,
  pipelineStages, projectHistory, cancelBody, canCancel, overviewOf, whyRan } from "./kiln.js";

const NOW = new Date(2026, 10, 18, 15, 0).getTime();

test("this machine's onix.kiln wins over Everywhere's, and only a bare http(s) origin counts as Kiln's website", () => {
  const file = { everywhere: { onix: { kiln: { url: "https://kiln.example:9443/", ca: "~/a.pem" } } },
    machines: { local: { onix: { kiln: { ca: "~/b.pem" } } } } };
  expect(kilnSettings(file)).toEqual({ url: "https://kiln.example:9443", origin: "https://kiln.example:9443", ca: "~/b.pem" });
  expect(kilnSettings({ everywhere: { onix: { kiln: { url: "https://kiln.example:9443/api" } } } }).url).toBeNull();
  expect(kilnSettings({ here: "box", machines: { box: { onix: { kiln: { url: "http://k:1" } } } } }).url).toBe("http://k:1");
  expect(kilnSettings({}).url).toBeNull();
});

test("a run's pill says what Kiln's website says", () => {
  expect(outcomeStatus("Pending", "active")).toEqual({ status: "running", label: "Running" });
  expect(outcomeStatus("Pending", "awaiting_approval")).toEqual({ status: "queued", label: "Awaiting approval" });
  expect(outcomeStatus(null, "queued")).toEqual({ status: "queued", label: "Queued" });
  expect(outcomeStatus("DomainFailure", "terminal")).toEqual({ status: "failure", label: "Failed" });
  expect(outcomeStatus("Unknown", "unknown")).toEqual({ status: "unknown", label: "Unknown" });
  expect(outcomeStatus(null, "terminal").label).toBe("Not recorded");
});

test("a failed run's retries say whether one passed", () => {
  expect(retryBadge({ outcome: "DomainFailure", retries: [{ outcome: "Success" }] })?.label).toBe("Failed, then passed on retry");
  expect(retryBadge({ outcome: "DomainFailure", retries: [{ outcome: "DomainFailure" }, { outcome: "Cancelled" }] })?.label).toBe("Retried 2 times; not passed");
  expect(retryBadge({ outcome: "Success", retries: [{ outcome: "Success" }] })).toBeNull();
});

test("durations and times read as on the website", () => {
  expect(formatDuration(4290)).toBe("4.2s");
  expect(formatDuration(42900)).toBe("42s");
  expect(formatDuration(187000)).toBe("3m 07s");
  expect(formatDuration(7500000)).toBe("2h 05m");
  expect(formatDuration(null)).toBe("Not recorded");
  expect(formatRelative(NOW - 30e3, NOW)).toBe("just now");
  expect(formatRelative(NOW - 59.5 * 60e3, NOW)).toBe("1h ago");
  expect(formatRelative(NOW - 3 * 86400e3, NOW)).toBe("3d ago");
});

test("the run list groups runs by their local start day, in the service's order", () => {
  const today = { id: "a", started_at_ms: NOW - 3600e3 }, yesterday = { id: "b", created_at_ms: NOW - 86400e3 }, none = { id: "c" };
  expect(dayGroups([today, yesterday, none], NOW).map((g) => [g.label, g.runs.length])).toEqual([["Today", 1], ["Yesterday", 1], ["Start not recorded", 1]]);
});

test("the run browser's filters become Kiln's query", () => {
  expect(runsQuery({ q: " mneme ", project: "mneme", outcome: "failed", order: "asc", cursor: "eyJ" }))
    .toBe("?limit=25&order=asc&q=mneme&project_id=mneme&outcome=failed&cursor=eyJ");
  expect(runsQuery({})).toBe("?limit=25&order=desc");
});

test("error lines are a compiler's and a test runner's, not a count of none", () => {
  const text = ["   Compiling x v0.1.0", "error[E0308]: mismatched types", "test result: FAILED. 1 passed; 1 failed", "0 errors, 2 warnings",
    "   Compiling error-chain v0.12.4", "thread 'main' panicked at src/lib.rs:3:5"].join("\n");
  expect(errorLines(text)).toEqual([1, 2, 5]);
});

test("a failed run's logs open on its failed node's stderr", () => {
  const run = { outcome: "DomainFailure", nodes: [{ id: "build", state: "Completed" }, { id: "test", state: "Failed" }] };
  expect(failureFirst(run)).toEqual({ node: "test", stream: "stderr" });
  expect(failureFirst({ outcome: "Success", nodes: [{ id: "test", state: "Completed" }] })).toEqual({ node: "test", stream: "stdout" });
});

test("pipeline stages follow the longest dependency path, and a cycle is a problem, not a graph", () => {
  const nodes = [{ id: "fmt" }, { id: "build" }, { id: "test" }];
  const staged = pipelineStages(nodes, [{ source: "build", target: "test" }, { source: "fmt", target: "test" }]);
  expect(staged.stages.map((s) => s.map((n) => n.id))).toEqual([["fmt", "build"], ["test"]]);
  expect(pipelineStages(nodes, [{ source: "build", target: "test" }, { source: "test", target: "build" }]).problem).toContain("cycle");
  expect(pipelineStages(nodes, null).problem).toContain("unavailable");
});

test("a project's streak counts its newest finished runs alike, and says 'at least' when the history was cut", () => {
  const ok = (o) => ({ phase: "terminal", outcome: "Success", completed_at_ms: o });
  const runs = [{ phase: "active", outcome: "Pending" }, ok(3), ok(2), { phase: "terminal", outcome: "DomainFailure", completed_at_ms: 1 }];
  const h = projectHistory(runs);
  expect(h.headline).toBe("Passing for 2 runs");
  expect(h.inProgress).toBe(1);
  expect(h.lastFailure?.completed_at_ms).toBe(1);
  expect(projectHistory([ok(2), ok(1)], { truncated: true }).headline).toBe("Passing for at least 2 runs");
});

test("cancelling names the exact attempt of an active run, and only asks for a queued one", () => {
  const active = { phase: "active", controls: { cancel: true }, attempt_id: "web-attempt-1", revision: 4, sequence: 7, execution: { native_id: "x" } };
  expect(cancelBody(active)).toEqual({ action: "cancel", attempt_id: "web-attempt-1", expected_revision: 4, expected_sequence: 7, execution: { native_id: "x" } });
  expect(cancelBody({ phase: "queued" })).toEqual({ action: "cancel" });
  expect(canCancel({ ...active, sequence: null })).toBe(false);
  expect(canCancel({ phase: "queued", controls: { cancel: true } })).toBe(true);
});

test("the overview puts failing projects first and leaves unknown and cancelled ones out of the pass rate", () => {
  const ov = overviewOf({ projects: [
    { id: "a", health: "healthy" }, { id: "b", health: "failing", latest_run: { completed_at_ms: 1 } },
    { id: "c", health: "failing", latest_run: { completed_at_ms: 2 } }, { id: "d", health: "unknown" }, { id: "e", health: "unavailable" }] });
  expect(ov.failing.map((p) => p.id)).toEqual(["c", "b"]);
  expect(ov.passRate).toBe(33);
  expect(ov.excluded).toEqual({ unknown: 1, cancelled: 0, none: 1 });
});

test("why a run ran: the changed files, then each recorded reason", () => {
  const why = whyRan({ affected: { changed: { exact_count: 3 }, reasons: [{ kind: "path", count: 3, sample: ["a.rs"] }, { kind: "fallback", reason: "no_base" }] } });
  expect(why?.changed).toBe("3 changed files against the previous revision.");
  expect(why?.reasons.map((r) => r.text)).toEqual(["3 changed files are in this project's scope.",
    "Ran to be safe: there was no earlier revision to compare with (a new reference or a manual run)."]);
  expect(whyRan({})).toBeNull();
});
