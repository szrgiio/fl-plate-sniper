#!/usr/bin/env node
// Usage:
//   node src/run.mjs --tier hot      # 1-letter, 2-letter, lists/words.txt  (every 15 min in Actions)
//   node src/run.mjs --tier sweep    # every 3-letter combo                 (twice daily)
//   node src/run.mjs --plates "CAVE,TOWER,HY"   # ad-hoc check, prints results
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FlPlateClient, DEFAULT_URL } from "./flhsmv.mjs";
import { buildTiers, normalizePlate, category } from "./lists.mjs";
import { notify } from "./notify.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const CONCURRENCY = +(process.env.CONCURRENCY || cfg.concurrency);
const DELAY_MS = +(process.env.DELAY_MS ?? cfg.delayMs);
const MAX_ATTEMPTS = cfg.maxAttempts;
const URL_ = process.env.FL_URL || DEFAULT_URL;
const DATA_DIR = process.env.DATA_DIR || join(ROOT, "docs");
const MAX_EVENTS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.7 + Math.random() * 0.6);
const now = () => new Date().toISOString();

function parseArgs(argv) {
  const a = { tier: null, plates: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--tier") a.tier = argv[++i];
    else if (argv[i] === "--plates") a.plates = argv[++i];
  }
  return a;
}

function loadState(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

// One plate per line keeps git diffs tiny.
function saveState(file, st) {
  mkdirSync(dirname(file), { recursive: true });
  const plates = Object.keys(st.plates).sort()
    .map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(st.plates[k])}`).join(",\n");
  const events = st.events.map((e) => `    ${JSON.stringify(e)}`).join(",\n");
  const head = { ...st }; delete head.plates; delete head.events;
  const headStr = JSON.stringify(head, null, 2).slice(0, -2);
  writeFileSync(file, `${headStr},\n  "events": [\n${events}\n  ],\n  "plates": {\n${plates}\n  }\n}\n`);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function checkAll(plates) {
  const batches = chunk(plates, 5);
  const results = new Map();
  let next = 0, failed = 0, done = 0, streak = 0, aborted = false;
  const started = Date.now();

  async function worker(id) {
    const client = new FlPlateClient({ url: URL_ });
    while (next < batches.length && !aborted) {
      const batch = batches[next++];
      let ok = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt++) {
        try {
          for (const r of await client.check(batch)) results.set(r.plate, r);
          ok = true;
        } catch (e) {
          client.form = null;
          if (attempt === MAX_ATTEMPTS) console.error(`[w${id}] gave up on ${batch.join(",")}: ${e.message}`);
          else await sleep(2000 * attempt * attempt);
        }
      }
      if (!ok) failed++;
      streak = ok ? 0 : streak + 1;
      // Circuit breaker: site is down or changed — stop instead of hammering it.
      if (streak >= 8 && !aborted) {
        aborted = true;
        console.error(`Aborting: ${streak} batches in a row failed`);
      }
      done++;
      if (done % 200 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        console.log(`  ${done}/${batches.length} batches (${rate.toFixed(1)}/s, ${failed} failed)`);
      }
      await sleep(jitter(DELAY_MS));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, (_, i) => worker(i + 1)));
  if (aborted) failed = batches.length - Math.round(results.size / 5);
  return { results, failed, total: batches.length };
}

function fmtList(ps, max = 40) {
  return ps.length > max ? `${ps.slice(0, max).join(", ")} … (+${ps.length - max} more)` : ps.join(", ");
}

async function main() {
  const args = parseArgs(process.argv);
  const adhoc = !!args.plates;
  const tierName = adhoc ? "adhoc" : args.tier || "hot";
  let plates;
  if (adhoc) {
    const raw = args.plates.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    for (const x of raw) if (!normalizePlate(x)) console.warn(`  skipping "${x}" (FL allows max 7 letters/digits plus one space or hyphen)`);
    plates = [...new Set(raw.map(normalizePlate).filter(Boolean))];
  } else {
    const tiers = buildTiers(join(ROOT, "lists", "words.txt"));
    if (!tiers[tierName]) throw new Error(`unknown tier "${tierName}" (use hot or sweep)`);
    plates = tiers[tierName];
  }
  if (!plates.length) { console.log("No valid plates to check."); return; }

  const file = join(DATA_DIR, `data-${tierName}.json`);
  const prev = loadState(file);
  const st = prev || { tier: tierName, plates: {}, events: [] };
  const baseline = !adhoc && !st.baselineDone;

  console.log(`Checking ${plates.length} plates (tier=${tierName}, ${Math.ceil(plates.length / 5)} requests, concurrency=${CONCURRENCY})`);
  const t0 = Date.now();
  const { results, failed, total } = await checkAll(plates);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`Done in ${secs}s — ${results.size}/${plates.length} checked, ${failed}/${total} batches failed`);

  const at = now();
  const newlyAvail = [], gone = [];
  for (const [p, r] of results) {
    const old = st.plates[p];
    const entry = { s: r.status, c: old && old.s === r.status ? old.c : at };
    if (r.status === "X") entry.r = r.text;
    st.plates[p] = entry;
    if (!old) {
      // A plate never seen before (e.g. you just added it to words.txt) that's open → alert.
      if (r.status === "A" && !baseline && !adhoc && ["word", "digits"].includes(category(p))) newlyAvail.push(p);
      continue;
    }
    if (old.s !== r.status) {
      st.events.unshift({ p, from: old.s, to: r.status, at });
      if (r.status === "A") newlyAvail.push(p);
      else if (old.s === "A" && r.status === "N") gone.push(p);
    }
  }
  // Drop plates removed from words.txt (not for ad-hoc, which accumulates).
  if (!adhoc && failed === 0) {
    const keep = new Set(plates);
    for (const p of Object.keys(st.plates)) if (!keep.has(p)) delete st.plates[p];
  }
  st.events = st.events.slice(0, MAX_EVENTS);
  st.checkedAt = at;
  st.durationSec = +secs;
  st.counts = {
    total: Object.keys(st.plates).length,
    available: Object.values(st.plates).filter((e) => e.s === "A").length,
  };
  const failRate = failed / total;
  if (baseline && failRate <= 0.5) st.baselineDone = true;
  st.lastError = failRate > 0 ? `${failed}/${total} batches failed` : null;

  // ---------- alerts ----------
  if (adhoc) {
    for (const p of plates) {
      const r = results.get(p);
      console.log(`  ${p.padEnd(8)} ${r ? (r.status === "A" ? "AVAILABLE" : r.status === "N" ? "taken" : `? ${r.text}`) : "ERROR"}`);
    }
  } else if (failRate > 0.5) {
    const lastBroken = st.brokenAlertAt ? Date.parse(st.brokenAlertAt) : 0;
    if (Date.now() - lastBroken > 6 * 3600e3) {
      st.brokenAlertAt = at;
      await notify({
        title: `Plate checker failing (${tierName})`,
        message: `${failed}/${total} requests failed. The FL site may be down or changed its form. Check the Actions log.`,
        priority: 4, tags: ["warning"],
      });
    }
  } else if (baseline) {
    const avail = plates.filter((p) => results.get(p)?.status === "A");
    const rare = avail.filter((p) => ["1-letter", "2-letter"].includes(category(p)));
    await notify({
      title: `Plate sniper is live (${tierName})`,
      message: `Baseline: ${avail.length} of ${results.size} available.` +
        (rare.length ? `\n1-2 letter OPEN NOW: ${rare.join(", ")}` : "") +
        (avail.length ? `\nAvailable: ${fmtList(avail)}` : "") +
        `\nYou'll be pinged when anything else frees up.`,
      priority: rare.length ? 5 : 3, tags: ["satellite"],
    });
  } else {
    const rare = newlyAvail.filter((p) => ["1-letter", "2-letter"].includes(category(p)));
    const words = newlyAvail.filter((p) => category(p) === "word" || category(p) === "digits");
    const three = newlyAvail.filter((p) => category(p) === "3-letter");
    for (const p of rare) {
      await notify({
        title: `🚨 ${p} is AVAILABLE in Florida`,
        message: `"${p}" just opened up. Get to the tax collector when they open, before someone else does.`,
        priority: 5, tags: ["rotating_light"],
      });
    }
    if (words.length) await notify({ title: `Word plate open: ${fmtList(words, 5)}`, message: `Newly available: ${fmtList(words)}`, priority: 4, tags: ["sparkles"] });
    if (three.length) await notify({ title: `${three.length} 3-letter plate(s) opened`, message: fmtList(three), priority: 3, tags: ["abc"] });
    const goneRare = gone.filter((p) => category(p) !== "3-letter");
    if (goneRare.length) await notify({ title: `Taken: ${fmtList(goneRare, 5)}`, message: `No longer available: ${fmtList(goneRare)}`, priority: 2, tags: ["x"] });
  }

  saveState(file, st);
  console.log(`Saved ${file} — ${st.counts.available} available, ${newlyAvail.length} newly available, ${gone.length} taken`);
  if (failRate > 0.5) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
});
