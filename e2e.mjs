// End-to-end test against a local mock of the FLHSMV ASP.NET form and a mock ntfy server.
// Run: node test/e2e.mjs
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { existsSync } from "node:fs";
const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = existsSync(join(HERE, "run.mjs")) ? join(HERE, "run.mjs") : join(HERE, "..", "src", "run.mjs");
const avail = new Set(["CAVE", "TOWER", "ZQX", "QQQ", "PAINT"]);
let broken = false, requests = 0, rejected = 0;
const sessions = new Map(); // session id -> current EVENTVALIDATION token

const ids = ["lblOutPutRowOne", "lblOutPutRowTwo", "lblOutputRowThree", "lblOutputRowFour", "lblOutputRowFive"];
const names = ["One", "Two", "Three", "Four", "Five"];
function page(sid, results = []) {
  const ev = Math.random().toString(36).slice(2) + "+/=";
  sessions.set(sid, ev);
  const rows = names.map((n, i) => `
    <input name="ctl00$MainContent$txtInputRow${n}" type="text" id="MainContent_txtInputRow${n}" />
    <span id="MainContent_${ids[i]}" class="out">${results[i] ?? " "}</span>`).join("");
  return `<!DOCTYPE html><html><body><form method="post" action="./" id="form1">
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="/wEPDwUL${Math.random().toString(36)}==" />
  <input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="0719FE0A" />
  <input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="${ev.replace(/&/g, "&amp;")}" />
  ${rows}
  <input type="submit" name="ctl00$MainContent$btnSubmit" value="Submit" id="MainContent_btnSubmit" />
  </form></body></html>`;
}

const fl = http.createServer((req, res) => {
  requests++;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (broken) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>Service Unavailable</html>"); }
    let sid = (req.headers.cookie || "").match(/ASP\.NET_SessionId=(\w+)/)?.[1];
    const headers = { "Content-Type": "text/html" };
    if (!sid) { sid = Math.random().toString(36).slice(2); headers["Set-Cookie"] = `ASP.NET_SessionId=${sid}; path=/; HttpOnly`; }
    if (req.method === "GET") { res.writeHead(200, headers); return res.end(page(sid)); }
    const f = new URLSearchParams(body);
    if (f.get("__EVENTVALIDATION") !== sessions.get(sid) || !f.has("ctl00$MainContent$btnSubmit")) {
      rejected++; res.writeHead(500, headers); return res.end("Invalid postback or callback argument");
    }
    const out = names.map((n) => {
      const v = (f.get(`ctl00$MainContent$txtInputRow${n}`) || "").trim();
      if (!v) return " ";
      return avail.has(v) ? "AVAILABLE" : "NOT AVAILABLE";
    });
    res.writeHead(200, headers); res.end(page(sid, out));
  });
});

const pushes = [];
const ntfy = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => { pushes.push(JSON.parse(b)); res.writeHead(200); res.end("{}"); });
});

await new Promise((r) => fl.listen(0, r));
await new Promise((r) => ntfy.listen(0, r));
const dataDir = mkdtempSync(join(tmpdir(), "plates-"));
const env = { ...process.env, FL_URL: `http://127.0.0.1:${fl.address().port}/mvcheckpersonalplate/`,
  NTFY_SERVER: `http://127.0.0.1:${ntfy.address().port}`, NTFY_TOPIC: "test-topic", DATA_DIR: dataDir, DELAY_MS: "0", CONCURRENCY: "6" };

// The runner is async; run it as a child process while this process keeps serving.
const { spawn } = await import("node:child_process");
const run = (...args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [RUN, ...args], { env });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => resolve({ code, out }));
});
const state = (t) => JSON.parse(readFileSync(join(dataDir, `data-${t}.json`), "utf8"));
const step = (s) => console.log(`\n▶ ${s}`);

try {
  step("1. hot baseline");
  let r = await run("--tier", "hot");
  console.log(r.out.trim().split("\n").slice(-2).join("\n"));
  assert.equal(r.code, 0);
  let s = state("hot");
  assert.equal(s.plates.CAVE.s, "A"); assert.equal(s.plates.HY.s, "N"); assert.equal(s.plates.A.s, "N");
  assert.equal(s.counts.total, 1163); assert.equal(s.counts.available, 3);
  assert.equal(rejected, 0, "server rejected postbacks — token refresh broken");
  assert.equal(pushes.length, 1); assert.match(pushes[0].title, /live/);
  console.log("  push:", pushes[0].title, "|", pushes[0].message.split("\n")[0]);

  step("2. no changes → no pushes");
  pushes.length = 0;
  r = await run("--tier", "hot"); assert.equal(r.code, 0); assert.equal(pushes.length, 0);

  step("3. HY + Q open, CAVE taken");
  avail.add("HY"); avail.add("Q"); avail.delete("CAVE");
  r = await run("--tier", "hot"); assert.equal(r.code, 0);
  for (const p of pushes) console.log(`  push [p${p.priority}]: ${p.title}`);
  assert.ok(pushes.some((p) => p.priority === 5 && p.title.includes("HY")));
  assert.ok(pushes.some((p) => p.priority === 5 && p.title.includes(" Q ")));
  assert.ok(pushes.some((p) => p.title.includes("Taken") && p.message.includes("CAVE")));
  s = state("hot");
  assert.equal(s.events.length, 3);
  assert.deepEqual(s.events.map((e) => e.p).sort(), ["CAVE", "HY", "Q"]);

  step("4. ad-hoc check");
  pushes.length = 0;
  r = await run("--plates", "tower, hy,bad!!,toolongplate,7");
  console.log(r.out.trim());
  assert.match(r.out, /TOWER\s+AVAILABLE/); assert.match(r.out, /HY\s+AVAILABLE/); assert.match(r.out, /7\s+taken/);
  assert.equal(pushes.length, 0);

  step("5. site down → one warning push, state kept, exit 1");
  broken = true; pushes.length = 0;
  r = await run("--tier", "hot");
  assert.equal(r.code, 1); assert.equal(pushes.length, 1); assert.match(pushes[0].title, /failing/);
  assert.equal(state("hot").plates.HY.s, "A", "previous results must survive an outage");
  r = await run("--tier", "hot"); assert.equal(pushes.length, 1, "warning should be throttled");
  broken = false;

  step("6. 3-letter sweep (17,502 plates)");
  pushes.length = 0;
  const t0 = Date.now();
  r = await run("--tier", "sweep");
  assert.equal(r.code, 0);
  s = state("sweep");
  assert.equal(s.counts.total, 17502); assert.equal(s.plates.ZQX.s, "A"); assert.equal(s.plates.QQQ.s, "A");
  console.log(`  ${s.counts.total} checked in ${((Date.now() - t0) / 1000).toFixed(1)}s locally, ${s.counts.available} available, baseline push: ${pushes[0]?.title}`);

  step("7. sweep picks up a newly opened 3-letter");
  avail.add("ABC"); pushes.length = 0;
  r = await run("--tier", "sweep");
  assert.ok(pushes.some((p) => p.message.includes("ABC")));
  console.log("  push:", pushes.map((p) => p.title).join(" | "));

  console.log(`\n✅ All checks passed (${requests} mock requests, ${rejected} rejected postbacks). Data in ${dataDir}`);
} catch (e) {
  console.error("\n❌", e.message);
  process.exitCode = 1;
} finally {
  fl.close(); ntfy.close();
  if (!process.env.KEEP) rmSync(dataDir, { recursive: true, force: true });
}
