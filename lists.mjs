import { readFileSync } from "node:fs";

const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export const oneLetter = () => [...A];
export const twoLetter = () => A.flatMap((a) => A.map((b) => a + b));
export const threeLetter = () => A.flatMap((a) => A.flatMap((b) => A.map((c) => a + b + c)));

// Florida: up to 7 characters (letters, digits, one space or hyphen).
export function normalizePlate(raw) {
  const p = String(raw).toUpperCase().trim().replace(/\s+/g, " ");
  if (!p) return null;
  if (!/^[A-Z0-9 -]+$/.test(p)) return null;
  if (p.replace(/[ -]/g, "").length > 7) return null;
  return p;
}

export function readList(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const clean = line.replace(/#.*/, "").trim();
    if (!clean) continue;
    for (const piece of clean.split(",")) {
      const p = normalizePlate(piece);
      if (p) out.push(p);
      else if (piece.trim()) console.warn(`skipping invalid plate in ${path}: "${piece.trim()}"`);
    }
  }
  return [...new Set(out)];
}

export function category(p) {
  if (/^[A-Z]$/.test(p)) return "1-letter";
  if (/^[A-Z]{2}$/.test(p)) return "2-letter";
  if (/^[A-Z]{3}$/.test(p)) return "3-letter";
  if (/^\d{1,3}$/.test(p)) return "digits";
  return "word";
}

/** hot = rare stuff checked every run; sweep = all 3-letter not already in hot. */
export function buildTiers(wordsPath) {
  const words = readList(wordsPath);
  const hot = [...new Set([...oneLetter(), ...twoLetter(), ...words])];
  const hotSet = new Set(hot);
  const sweep = threeLetter().filter((p) => !hotSet.has(p));
  return { hot, sweep };
}
