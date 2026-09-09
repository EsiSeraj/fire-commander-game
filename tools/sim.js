// Headless harness: screenshot + fast-forwarded automated missions per difficulty.
// Usage: N=20 DIFFS=easy,moderate,hard node sim.js
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");

const DIR = path.join(__dirname, "..");
const OUT = path.join(__dirname, "output");
fs.mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = (req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0]);
      const f = path.join(DIR, p);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": MIME[path.extname(f)] || "text/plain" });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

const SNAP = `(() => { const s = window.FireCommander.state; return {
  finished: s.finished, won: s.won, elapsed: s.elapsedMs / 1000, fires: s.fires.size, marked: s.marked.size,
  water: s.waterUsed, spread: s.spreadCells.size, infra: s.infraHit.size, score: s.score, seed: s.seed,
  extinguished: s.extinguishedCount, breakdown: s.breakdown, terrainCounts: s.terrain.reduce((m, t) => (m[t] = (m[t] || 0) + 1, m), {}),
}; })()`;

async function newPage(browser, base, errors) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.goto(base);
  return { ctx, page };
}

const OVERRIDE = process.env.OVERRIDE ? JSON.parse(process.env.OVERRIDE) : null;

async function applyOverride(page) {
  if (!OVERRIDE) return;
  await page.evaluate((o) => {
    const FC = window.FireCommander;
    for (const k of Object.keys(o.difficulties || {})) Object.assign(FC.DIFFICULTIES[k], o.difficulties[k]);
    for (const k of Object.keys(o.robots || {})) Object.assign(FC.ROBOTS[k], o.robots[k]);
    Object.assign(FC.REWARD, o.reward || {});
  }, OVERRIDE);
}

async function runMission(browser, base, difficulty, { autoP, autoA, seed }, errors) {
  const { ctx, page } = await newPage(browser, base + (seed ? `?seed=${seed}` : ""), errors);
  await applyOverride(page);
  await page.click(`button[data-difficulty="${difficulty}"]`);
  if (autoP) await page.click("#autoPerceptionBtn");
  if (autoA) await page.click("#autoActionBtn");
  await page.click("#startBtn");
  const budget = (await page.evaluate((d) => window.FireCommander.DIFFICULTIES[d].seconds, difficulty)) * 1000 + 1000;
  let elapsed = 0;
  let snap = null;
  while (elapsed < budget) {
    await page.clock.runFor(1000);
    elapsed += 1000;
    snap = await page.evaluate(SNAP);
    if (snap.finished) break;
  }
  await ctx.close();
  return snap;
}

function median(xs) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function mean(xs) { return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : null; }

(async () => {
  const { srv, port } = await serve();
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const errors = [];

  if (process.env.SHOT !== "0") {
    const { ctx, page } = await newPage(browser, base, errors);
    await page.click('button[data-difficulty="moderate"]');
    await page.screenshot({ path: path.join(OUT, "shot_idle.png") });
    await page.click("#autoPerceptionBtn");
    await page.click("#autoActionBtn");
    await page.click("#startBtn");
    await page.clock.runFor(30000);
    await page.screenshot({ path: path.join(OUT, "shot_running.png") });
    // run to the end for the summary card
    for (let i = 0; i < 140; i++) { await page.clock.runFor(1000); if ((await page.evaluate(SNAP)).finished) break; }
    await page.screenshot({ path: path.join(OUT, "shot_end.png") });
    await ctx.close();
  }

  const N = parseInt(process.env.N || "12", 10);
  const diffs = (process.env.DIFFS || "easy,moderate,hard").split(",");
  const out = {};
  for (const d of diffs) {
    const runs = [];
    for (let i = 0; i < N; i++) runs.push(await runMission(browser, base, d, { autoP: true, autoA: true, seed: 1000 + i }, errors));
    const wins = runs.filter((r) => r.won);
    out[d] = {
      n: N,
      winRate: +(wins.length / N).toFixed(2),
      clearMedian: median(wins.map((r) => r.elapsed)),
      clearRange: wins.length ? [Math.min(...wins.map((r) => r.elapsed)), Math.max(...wins.map((r) => r.elapsed))] : null,
      firesLeftOnLoss: runs.filter((r) => !r.won).map((r) => r.fires),
      waterMean: mean(runs.map((r) => r.water)),
      spreadMean: mean(runs.map((r) => r.spread)),
      infraMean: mean(runs.map((r) => r.infra)),
      scoreMedian: median(runs.map((r) => r.score)),
      scoreRange: [Math.min(...runs.map((r) => r.score)), Math.max(...runs.map((r) => r.score))],
    };
    console.log(d, JSON.stringify(out[d]));
  }

  if (process.env.ONESIDED === "1") {
    for (const cfg of [{ autoP: true, autoA: false }, { autoP: false, autoA: true }]) {
      const r = await runMission(browser, base, "hard", { ...cfg, seed: 7 }, errors);
      console.log("hard one-sided", JSON.stringify(cfg), JSON.stringify({ fires: r.fires, marked: r.marked, spread: r.spread, score: r.score }));
    }
  }

  console.log("page errors:", errors.length ? errors : "none");
  fs.writeFileSync(path.join(OUT, "baseline.json"), JSON.stringify(out, null, 2));
  await browser.close();
  srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
