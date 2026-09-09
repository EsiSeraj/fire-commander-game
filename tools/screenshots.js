// Regenerates the README screenshots in docs/screenshots on a real clock
// (CSS transitions do not settle under fake timers).
//
//   npm run screenshots
//   SEED_MISSION=1234 SEED_AFTERMATH=99 SEED_SUMMARY=4242 node tools/screenshots.js
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const SEED_MISSION = process.env.SEED_MISSION || "31415926";
const SEED_AFTERMATH = process.env.SEED_AFTERMATH || "27182818";
const SEED_SUMMARY = process.env.SEED_SUMMARY || "4242";

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0];
      const f = path.join(ROOT, p);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": MIME[path.extname(f)] || "text/plain" });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

const finished = () => window.FireCommander.state.finished;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { srv, port } = await serve();
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("page error:", e));

  // 1) Mid-mission, both robots automated: belief map, fog, marked fires.
  await page.goto(`${base}?seed=${SEED_MISSION}`);
  await page.click('button[data-difficulty="moderate"]');
  for (const id of ["#autoPerceptionBtn", "#autoActionBtn"]) {
    if (!(await page.locator(id).evaluate((b) => b.classList.contains("active")))) await page.click(id);
  }
  await page.click("#startBtn");
  // capture at a lively moment: a few fires marked and burning, some ground already stale
  const lively = () => {
    const s = window.FireCommander.state;
    return s.elapsedMs >= 9000 && s.marked.size >= 2 && s.fires.size >= 3 && s.extinguished.size >= 2;
  };
  const deadline = Date.now() + parseInt(process.env.MISSION_WAIT_MS || "45000", 10);
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    if (await page.evaluate(lively)) break;
    if (await page.evaluate(finished)) break;
  }
  await page.screenshot({ path: path.join(OUT, "mission.png") });
  console.log("wrote mission.png at", await page.evaluate(() => window.FireCommander.state.elapsedMs / 1000), "s");

  // 2) A Hard mission run to the end by the bots, then the board with the fog lifted:
  //    every terrain type, burnt ground, and whatever was still burning.
  await page.goto(`${base}?seed=${SEED_AFTERMATH}`);
  await page.click('button[data-difficulty="hard"]');
  for (const id of ["#autoPerceptionBtn", "#autoActionBtn"]) {
    if (!(await page.locator(id).evaluate((b) => b.classList.contains("active")))) await page.click(id);
  }
  await page.click("#startBtn");
  for (let i = 0; i < 130; i += 1) {
    await page.waitForTimeout(1000);
    if (await page.evaluate(finished)) break;
  }
  await page.click("#summaryClose");
  await page.waitForTimeout(400);
  await page.locator(".board-wrap").screenshot({ path: path.join(OUT, "aftermath.png") });
  console.log("wrote aftermath.png", await page.evaluate(() => { const s = window.FireCommander.state; return { won: s.won, burned: s.spreadCells.size, left: s.fires.size }; }));

  // 3) End-of-mission summary card (Easy, both automated, real clock).
  await page.goto(`${base}?seed=${SEED_SUMMARY}`);
  await page.click('button[data-difficulty="easy"]');
  for (const id of ["#autoPerceptionBtn", "#autoActionBtn"]) {
    if (!(await page.locator(id).evaluate((b) => b.classList.contains("active")))) await page.click(id);
  }
  await page.click("#startBtn");
  for (let i = 0; i < 150; i += 1) {
    await page.waitForTimeout(1000);
    if (await page.evaluate(finished)) break;
  }
  await page.waitForTimeout(500);
  await page.locator(".board-wrap").screenshot({ path: path.join(OUT, "summary.png") });
  console.log("wrote summary.png");

  await browser.close();
  srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
