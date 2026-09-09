// Real-clock checks of the human controls, persistence, and the end-of-mission card.
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
      const p = req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0];
      const f = path.join(DIR, p);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": MIME[path.extname(f)] || "text/plain" });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}
const S = () => `(() => { const s = window.FireCommander.state; return { drone: {x: s.drone.x, y: s.drone.y}, rover: {x: s.rover.x, y: s.rover.y}, marked: [...s.marked], fires: [...s.fires.keys()], water: s.waterUsed, score: s.score, finished: s.finished, won: s.won, log: s.log.slice(0,3).map(l => l.text), terrain: s.terrain, size: s.size }; })()`;

(async () => {
  const { srv, port } = await serve();
  const base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const results = {};

  // A fixed seed so the map is reproducible
  await page.goto(base + "?seed=4242");
  await page.click('button[data-difficulty="easy"]');
  await page.click("#startBtn");
  await page.locator("body").focus();

  // 1) Held key cadence: hold ArrowRight for ~1.05s -> expect ~5 moves (200ms each) unless blocked
  let before = await page.evaluate(S());
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(1050);
  await page.keyboard.up("ArrowRight");
  let after = await page.evaluate(S());
  results.heldMoveDx = after.drone.x - before.drone.x;
  results.rowTerrain = before.terrain.slice(0, before.size);

  // 2) A tap inside the cooldown is queued and lands once; a second tap inside the same window does not double it
  before = await page.evaluate(S());
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown"); // within 200 ms
  await page.waitForTimeout(300);
  after = await page.evaluate(S());
  results.doubleTapDy = after.drone.y - before.drone.y;

  // 3) Marking / extinguishing: teleport the robots onto a fire (test hook: mutate state)
  const fireIdx = await page.evaluate(() => {
    const s = window.FireCommander.state; const i = [...s.fires.keys()][0]; const x = i % s.size; const y = (i - x) / s.size;
    s.drone.x = x; s.drone.y = y; s.rover.x = x; s.rover.y = y; return i;
  });
  await page.keyboard.press("ShiftLeft"); // blind: should not extinguish
  await page.waitForTimeout(350);
  let st = await page.evaluate(S());
  results.blindExtinguishWater = st.water;
  results.blindMessage = st.log[0];
  await page.keyboard.press("ShiftRight"); // mark
  await page.waitForTimeout(350);
  st = await page.evaluate(S());
  results.markedAfterShiftRight = st.marked.includes(fireIdx);
  await page.keyboard.press("ShiftLeft"); // extinguish
  await page.waitForTimeout(350);
  st = await page.evaluate(S());
  results.extinguishedAfterShiftLeft = !st.fires.includes(fireIdx);
  results.waterAfter = st.water;
  results.scoreAfter = st.score;

  // 4) Mountain blocks: find a mountain adjacent to some ground cell, put the rover next to it, push into it
  const block = await page.evaluate(() => {
    const s = window.FireCommander.state; const n = s.size * s.size;
    for (let i = 0; i < n; i++) if (s.terrain[i] === "mountain") { const x = i % s.size, y = (i - x) / s.size;
      if (x > 0 && s.terrain[i - 1] === "grass") { s.rover.x = x - 1; s.rover.y = y; return { x: x - 1, y, dir: "KeyD" }; } }
    return null;
  });
  if (block) {
    await page.keyboard.press(block.dir);
    await page.waitForTimeout(100);
    st = await page.evaluate(S());
    results.mountainBlocked = st.rover.x === block.x && st.rover.y === block.y;
    results.blockMessage = st.log[0];
  }

  // 5) Lake: drone may enter, rover may not
  const lake = await page.evaluate(() => {
    const s = window.FireCommander.state; const n = s.size * s.size;
    for (let i = 0; i < n; i++) if (s.terrain[i] === "lake") { const x = i % s.size, y = (i - x) / s.size;
      if (x > 0 && s.terrain[i - 1] === "grass") { s.rover.x = x - 1; s.rover.y = y; s.drone.x = x - 1; s.drone.y = y; return { x, y }; } }
    return null;
  });
  if (lake) {
    await page.waitForTimeout(300);
    await page.keyboard.press("KeyD");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
    st = await page.evaluate(S());
    results.lakeRoverBlocked = st.rover.x === lake.x - 1;
    results.lakeDroneEntered = st.drone.x === lake.x;
  }

  // 6) Let the bots finish the mission (real clock), then check the summary card and persistence
  await page.click("#autoPerceptionBtn");
  await page.click("#autoActionBtn");
  for (let i = 0; i < 150; i++) { await page.waitForTimeout(1000); st = await page.evaluate(S()); if (st.finished) break; }
  results.finished = st.finished; results.won = st.won; results.finalScore = st.score;
  results.summaryVisible = await page.evaluate(() => !document.querySelector("#summary").hidden);
  results.summaryText = await page.evaluate(() => document.querySelector("#summaryBody").innerText.replace(/\s+/g, " ").slice(0, 300));
  await page.screenshot({ path: path.join(OUT, "shot_manual_end.png") });
  results.stored = await page.evaluate(() => localStorage.getItem("firecommander.v2"));

  // reload: settings and record should persist
  await page.reload();
  await page.waitForTimeout(300);
  results.afterReloadBest = await page.evaluate(() => document.querySelector("#bestLine").textContent);
  results.afterReloadAutoP = await page.evaluate(() => document.querySelector("#autoPerceptionBtn").classList.contains("active"));

  console.log(JSON.stringify(results, null, 2));
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
