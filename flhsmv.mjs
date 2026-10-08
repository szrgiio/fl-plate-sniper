// Client for Florida's public personalized-plate checker (ASP.NET Web Form).
// One instance = one session. Checks up to 5 plates per POST.

export const DEFAULT_URL = "https://services.flhsmv.gov/mvcheckpersonalplate/";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const ROW_WORDS = ["one", "two", "three", "four", "five"];

// Fallbacks taken from the published request; live names are read from the page when present.
const FALLBACK_INPUTS = ROW_WORDS.map(
  (w) => `ctl00$MainContent$txtInputRow${w[0].toUpperCase()}${w.slice(1)}`
);
const FALLBACK_SUBMIT = "ctl00$MainContent$btnSubmit";

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i")) ||
    tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"));
  return m ? decodeEntities(m[1]) : null;
}

/** Pull hidden fields, plate input names and the submit button out of the form page. */
export function parseForm(html) {
  const hidden = {};
  const inputs = [];
  let submit = null;
  for (const tag of html.match(/<input\b[^>]*>/gi) || []) {
    const type = (attr(tag, "type") || "text").toLowerCase();
    const name = attr(tag, "name");
    if (!name) continue;
    if (type === "hidden") hidden[name] = attr(tag, "value") ?? "";
    else if (type === "submit" && /btnSubmit/i.test(name)) submit = { name, value: attr(tag, "value") || "Submit" };
    else if (/txtInputRow/i.test(name)) inputs.push(name);
  }
  const ordered = ROW_WORDS.map(
    (w) => inputs.find((n) => new RegExp(`txtInputRow${w}$`, "i").test(n))
  );
  return {
    hidden,
    inputs: ordered.every(Boolean) ? ordered : FALLBACK_INPUTS,
    submit: submit || { name: FALLBACK_SUBMIT, value: "Submit" },
    hasState: "__VIEWSTATE" in hidden && "__EVENTVALIDATION" in hidden,
  };
}

/** Read the five result labels (ids vary in casing: lblOutPutRowOne / lblOutputRowThree). */
export function parseResults(html) {
  const out = new Array(5).fill(null);
  const re = /<span\b[^>]*\bid\s*=\s*"[^"]*lblOutput?Row(One|Two|Three|Four|Five)"[^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = re.exec(html))) {
    const idx = ROW_WORDS.indexOf(m[1].toLowerCase());
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    out[idx] = text;
  }
  return out;
}

export function classify(text) {
  const t = (text || "").toUpperCase();
  if (t === "AVAILABLE") return "A";
  if (t.includes("NOT AVAILABLE") || t.includes("UNAVAILABLE")) return "N";
  return "X"; // anything else (invalid, blank, new wording) — never triggers an alert
}

export class FlPlateClient {
  constructor({ url = DEFAULT_URL, timeoutMs = 25000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.cookies = new Map();
    this.form = null;
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorbCookies(res) {
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async request(method, body) {
    const headers = {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    if (body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers.Origin = new URL(this.url).origin;
      headers.Referer = this.url;
    }
    const res = await fetch(this.url, {
      method,
      headers,
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.absorbCookies(res);
    const html = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return html;
  }

  async init() {
    const html = await this.request("GET");
    this.form = parseForm(html);
    if (!this.form.hasState) throw new Error("Form page missing __VIEWSTATE/__EVENTVALIDATION (site changed or blocked)");
  }

  /** Check 1–5 plates. Returns [{plate, status:'A'|'N'|'X', text}] */
  async check(plates) {
    if (plates.length < 1 || plates.length > 5) throw new Error("check() takes 1-5 plates");
    if (!this.form) await this.init();
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(this.form.hidden)) p.append(k, v);
    this.form.inputs.forEach((name, i) => p.append(name, plates[i] ? plates[i].toUpperCase() : ""));
    p.append(this.form.submit.name, this.form.submit.value);

    const html = await this.request("POST", p.toString());
    const texts = parseResults(html);
    // Refresh tokens from the response so the next POST is a valid postback.
    const next = parseForm(html);
    if (next.hasState) this.form = next;

    const missing = plates.some((_, i) => texts[i] === null);
    if (missing) {
      this.form = null; // force a fresh session next time
      throw new Error("Result labels not found in response (site changed, error page, or throttled)");
    }
    return plates.map((plate, i) => ({ plate, status: classify(texts[i]), text: texts[i] }));
  }
}
