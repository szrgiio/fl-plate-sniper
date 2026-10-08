// Push alerts via ntfy (https://ntfy.sh). JSON publishing avoids header-encoding issues with emoji.
const CHECKER_URL = "https://services.flhsmv.gov/mvcheckpersonalplate/";
const MAX_CHARS = 3500; // ntfy truncates message bodies around 4 KB, so long lists are split.

// Tapping a push opens your dashboard (GitHub Pages); a button still links to the state checker.
function dashboardUrl() {
  if (process.env.DASHBOARD_URL) return process.env.DASHBOARD_URL;
  const repo = process.env.GITHUB_REPOSITORY; // "owner/name" inside GitHub Actions
  if (repo && repo.includes("/")) {
    const [owner, name] = repo.split("/");
    return `https://${owner.toLowerCase()}.github.io/${name}/`;
  }
  return CHECKER_URL;
}

function split(message) {
  if (message.length <= MAX_CHARS) return [message];
  const parts = [];
  let cur = "";
  for (const piece of message.split(/(?<=, )/)) {
    if ((cur + piece).length > MAX_CHARS) { parts.push(cur); cur = ""; }
    cur += piece;
  }
  if (cur) parts.push(cur);
  return parts;
}

async function send(body) {
  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
  try {
    const res = await fetch(server + "/", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!res.ok) console.error(`ntfy returned HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error(`ntfy failed: ${e.message}`);
    return false;
  }
}

export async function notify({ title, message, priority = 3, tags = [], click }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log(`[notify skipped — NTFY_TOPIC not set] ${title}: ${message}`);
    return false;
  }
  const parts = split(message);
  let ok = true;
  for (let i = 0; i < parts.length; i++) {
    ok = (await send({
      topic,
      title: parts.length > 1 ? `${title} (${i + 1}/${parts.length})` : title,
      message: parts[i],
      priority, tags,
      click: click || dashboardUrl(),
      actions: [{ action: "view", label: "FLHSMV checker", url: CHECKER_URL }],
    })) && ok;
  }
  return ok;
}
