import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPT, acceptLabel, cairnLine, cairnState, cairnWords, words, readable, whereNow, commitsLine, filesLine, moreLine, proofTitle } from "./accept.js";

const root = join(import.meta.dir, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("a long old summary keeps its first sentence; the whole goes under Details", () => {
  const long = `Fixed the login. ${"More words here. ".repeat(12)}`;
  const w = words({ summary: long });
  expect(w.summary).toBe("Fixed the login. More words here. More words here. More words here. More words here. More words here. More words here. More words here. More words here.");
  expect(w.details).toBe(long.trim());
  expect(words({ summary: "Short.", details: "x" })).toEqual({ summary: "Short.", details: "x" });
});

test("plain details become bullets, clear paths as code; markdown stays", () => {
  expect(readable("Changed web/src/App.tsx. The tests pass now; all good")).toBe("- Changed `web/src/App.tsx`\n- The tests pass now; all good");
  expect(readable("- one\n- two")).toBe("- one\n- two");
});

test("the card's words", () => {
  expect(ACCEPT.title("HERD-4")).toBe("Accept HERD-4?");
  expect(whereNow({ state: "done", accepted_at: 1 })).toBe("Already accepted.");
  expect(whereNow({ state: "done" })).toBe("Already done.");
  expect(whereNow({ state: "work", status_text: "Working" })).toBe("Not ready right now: it's in Working.");
  expect([commitsLine(1), filesLine(3), moreLine(2)]).toEqual(["1 commit", "3 files changed", "And 2 more"]);
  expect(proofTitle("HERD-4: Login works")).toBe("Login works");
});

// SHEP-225 (#1046): the button says what pressing it does
test("Accept says whether it merges", () => {
  expect(acceptLabel({ merges: true })).toBe("Accept and merge");
  expect(acceptLabel({ merges: false })).toBe("Accept");
  expect(acceptLabel(undefined)).toBe("Accept"); // still being read
  const mod = read("mods/accept-card/main.js"), web = read("web/src/screens/Accept.tsx");
  expect(mod).toContain("acceptLabel(e)");
  expect(web).toContain("A.acceptLabel(e)");
});

test("the window's card and the web's read their words from here, not their own", () => {
  const mod = read("mods/accept-card/main.js"), web = read("web/src/screens/Accept.tsx");
  expect(mod).toContain('from "./core/accept.js"');
  expect(web).toContain("@core/accept.js");
  for (const w of ["Reading the task", "No summary.", "No proof artifact.", "Already accepted.", "Not ready right now",
                   "No Cairn change linked.", "Gates pass", "no pull request."]) {
    expect(mod).not.toContain(w);
    expect(web).not.toContain(w);
  }
});

// onix: the linked Cairn change's gates, and what Accept does in an Onix repo (a fast-forward and push, no PR)
test("a Cairn change reads passed only when every gate said PASS and validate is valid", () => {
  const pass = { change: "add-gates", gates: { proposal: "PASS", design: "PASS", tasks: "PASS" }, valid: true };
  expect(cairnState(pass)).toBe("passed");
  expect(cairnState({ ...pass, gates: { ...pass.gates, design: "FAIL" } })).toBe("failed");
  expect(cairnState({ ...pass, valid: false })).toBe("failed");
  // an error (no cairn there, a policy skew) and a gate that didn't say PASS are unknown, never a pass
  expect(cairnState({ ...pass, gates: { ...pass.gates, tasks: "unknown" } })).toBe("unknown");
  expect(cairnState({ ...pass, valid: null })).toBe("unknown");
  expect(cairnState(undefined)).toBe("none");
  expect(cairnLine(pass)).toBe("proposal pass · design pass · tasks pass");
  expect(cairnLine({ ...pass, gates: { ...pass.gates, design: "FAIL" } })).toBe("proposal pass · design fail · tasks pass");
  expect([cairnWords("passed"), cairnWords("failed"), cairnWords("unknown"), cairnWords("none")])
    .toEqual(["Gates pass", "Gates fail", "Gates unknown", "Gates unknown"]);
  expect(ACCEPT.onixMerge("main")).toBe("Accept fast-forwards main and pushes it to origin: no pull request.");
});

test("both cards show the Cairn verdicts and say what Accept does in an Onix repo", () => {
  const mod = read("mods/accept-card/main.js"), web = read("web/src/screens/Accept.tsx");
  for (const src of [mod, web]) {
    expect(src).toContain("cairnState");
    expect(src).toContain("cairnLine");
    expect(src).toContain("ACCEPT.onixMerge");
    expect(src).toContain("ACCEPT.cairn");
  }
});
