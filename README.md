# FL Plate Sniper

Free, self-hosted version of PlateRadar for Florida. Runs on GitHub Actions, checks the official FLHSMV plate checker, and pushes to your phone the moment a plate frees up.

| What | Plates | How often |
|---|---|---|
| Rare + words | all 1-letter (26), all 2-letter (676), everything in `lists/words.txt` (~460) | every 15 min |
| 3-letter sweep | all 17,576 3-letter combos | twice a day (~5:23 AM / PM ET) |
| Ad-hoc | anything you type in | on demand |

Alerts (ntfy push): urgent for 1–2 letter openings, high for words, normal for 3-letter. You also get a heads-up if the state site goes down or changes its form.

Dashboard (GitHub Pages): what's open now, a 26×26 two-letter board, recent changes, and search.

---

## Setup (~15 minutes)

### 1. Phone alerts
1. Install **ntfy** (App Store / Play Store).
2. Tap **+**, subscribe to topic: `sgee-plates-b5dd155aff`
   Keep this name private; anyone who knows it can read your alerts. Change it if you like, just keep it random.
3. In the topic settings, allow urgent notifications to break through Do Not Disturb if you want 6 AM wake-ups for 2-letter drops.

### 2. GitHub repo
Make it **public**: unlimited free Actions minutes and free Pages. (The data is the same public info the state shows; your ntfy topic stays secret.)

From Terminal, in the unzipped folder:
```bash
git init -b main
git add .
git commit -m "plate sniper"
gh repo create fl-plate-sniper --public --source . --push
```
No `gh`? Create an empty public repo named `fl-plate-sniper` on github.com, then:
```bash
git remote add origin https://github.com/<you>/fl-plate-sniper.git
git push -u origin main
```

### 3. Secret
Repo → **Settings → Secrets and variables → Actions → New repository secret**
- Name: `NTFY_TOPIC`  Value: `sgee-plates-b5dd155aff`

### 4. Dashboard
Repo → **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, folder `/docs` → Save.
Your dashboard: `https://<you>.github.io/fl-plate-sniper/`

### 5. First run
Repo → **Actions** → enable workflows if prompted → **plate-sniper** → **Run workflow**:
1. Run with tier `hot` (~2 min). You should get a "Plate sniper is live" push listing what's open right now.
2. Run again with tier `sweep` (~25 min) to fill in all 3-letter combos.

After that it runs itself.

---

## Day to day

- **Add/remove watched words:** edit `lists/words.txt` on github.com and commit. Max 7 characters. New words that are already open get pushed on the next run.
- **Check something right now:** Actions → plate-sniper → Run workflow → put plates in the box (`CAVE,TOWER,HY`). Results show in the run log and on the dashboard. The dashboard's "Check specific plates" button links there.
- **Locally:** `node src/run.mjs --plates "CAVE,TOWER"` (Node 20+, no installs).

## When you get the push
Florida personalized plates are claimed in person at a county tax collector office. Rare plates go fast: in the blog you sent, a 2-letter plate got claimed at 8 AM opening the day after it showed up. Go at opening, bring your registration, and check availability on your phone in line. Call your office first to ask whether they'll take the order over the phone or online.

## Tuning
- `config.json`: `concurrency` (parallel sessions, default 3) and `delayMs` (pause per request, default 400). These are deliberately gentle so the state server isn't hammered; a full hot run is ~230 requests over ~2 min.
- Schedule: `.github/workflows/sniper.yml`. GitHub's cron can run 5–20 min late at busy times; that's the main speed limit of the free setup.
- If you'd rather keep the repo private: free private repos get 2,000 Actions minutes/month, so change the hot schedule to `"0 * * * *"` (hourly) and the sweep to once a day.
- GitHub pauses scheduled workflows in a public repo after 60 days with no activity. The result commits should keep it active; if it ever pauses, GitHub emails you and one click re-enables it.

## How it works
`src/flhsmv.mjs` loads the ASP.NET form (session cookie + `__VIEWSTATE`/`__EVENTVALIDATION`), posts 5 plates per request, reads each `AVAILABLE` / `NOT AVAILABLE` label, and refreshes the form tokens from each response. `src/run.mjs` compares against the last run (`docs/data-*.json`), records changes, sends alerts, and stops early if the site starts failing. `npm test` runs the whole thing against a local mock of the site.
