// Push alerts via ntfy (https://ntfy.sh). JSON publishing avoids header-encoding issues with emoji.
const CHECKER_URL = "https://services.flhsmv.gov/mvcheckpersonalplate/";

export async function notify({ title, message, priority = 3, tags = [], click = CHECKER_URL }) {
  const topic = process.env.NTFY_TOPIC;
  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  if (!topic) {
    console.log(`[notify skipped — NTFY_TOPIC not set] ${title}: ${message}`);
    return false;
  }
  const headers = { "Content-Type": "application/json" };
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
  try {
    const res = await fetch(server + "/", {
      method: "POST",
      headers,
      body: JSON.stringify({ topic, title, message, priority, tags, click }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.error(`ntfy returned HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error(`ntfy failed: ${e.message}`);
    return false;
  }
}
