"use strict";

/* =====================================================================
   FireCommander — game logic

   Two robots on a grid. The perception robot (P) is the only one that
   observes fire; the action robot (A) is the only one that can put it
   out, and only where P has marked it.

   Everything drawn on the board is P's *belief* about the world, not the
   world itself. A cell's belief decays exponentially from the moment it
   was last scanned (memoryHalfLifeMs); stale cells fog over, and fire
   that spreads into an unscanned cell is invisible until P looks again.
   The panel never reports hidden fires.

   Time advances in fixed TICK_MS steps. Human-controlled robots move by
   held keys at the same cadence the automated policies use, so neither
   side is faster than the other.
   ===================================================================== */

// ---------- Tunables ----------

const TICK_MS = 50; // simulation step
const FOG_REPAINT_MS = 200; // repaint cadence for fog decay when nothing else changed
const FRESH_CONFIDENCE = 0.35; // policies treat a cell as recently seen above this
const SIGHTED_CONFIDENCE = 0.04; // below this a remembered fire is no longer drawn
const LOG_LINES = 4;
const STORAGE_KEY = "firecommander.v2";

const TERRAIN = {
  grass: { label: "Grass", burnable: true, ground: true, fireHp: 1, spreadMult: 1, burnPenalty: 30 },
  tree: { label: "Trees", burnable: true, ground: true, fireHp: 2, spreadMult: 1.5, burnPenalty: 45 },
  building: { label: "Building", burnable: true, ground: true, fireHp: 1, spreadMult: 1, burnPenalty: 30 },
  mountain: { label: "Mountain", burnable: false, ground: false, fireHp: 0, spreadMult: 0, burnPenalty: 0 },
  lake: { label: "Lake", burnable: false, ground: false, fireHp: 0, spreadMult: 0, burnPenalty: 0 },
};

const ROBOTS = {
  drone: {
    label: "perception robot",
    moveEveryMs: 200,
    actEveryMs: 250,
    canCross: (type) => type !== "mountain",
  },
  rover: {
    label: "action robot",
    moveEveryMs: 280,
    actEveryMs: 300,
    canCross: (type) => TERRAIN[type].ground,
  },
};

// Tuned against the built-in policies (both robots automated, headless,
// 20 seeds each): the bots always clear Easy in ~15 s, always clear Moderate
// but need about half the clock and score anywhere from slightly negative to
// ~1100, and win Hard about 60% of the time. Two bots are the strongest
// possible team, so expect each tier to feel a step harder with a human in
// either seat.
const DIFFICULTIES = {
  easy: {
    label: "Easy",
    size: 9,
    initialFires: 4,
    seconds: 140,
    spreadEveryMs: 2800,
    spreadChance: 0.18,
    memoryHalfLifeMs: 45000,
    terrain: { mountain: 0.06, lake: 0.05, tree: 0.14, buildings: 2 },
  },
  moderate: {
    label: "Moderate",
    size: 12,
    initialFires: 7,
    seconds: 105,
    spreadEveryMs: 2400,
    spreadChance: 0.3,
    memoryHalfLifeMs: 36000,
    terrain: { mountain: 0.07, lake: 0.06, tree: 0.16, buildings: 3 },
  },
  hard: {
    label: "Hard",
    size: 15,
    initialFires: 9,
    seconds: 118,
    spreadEveryMs: 2400,
    spreadChance: 0.32,
    memoryHalfLifeMs: 30000,
    terrain: { mountain: 0.08, lake: 0.07, tree: 0.18, buildings: 4 },
  },
};

// Score is a cumulative reward. Burn damage is charged when the perception
// robot discovers it (or at mission end for anything never found), so the
// live score never leaks what is happening in unscanned cells.
//
// Balance rule: letting fire spread must never pay. A spread cell costs at
// least 30, and knocking it down later earns 25 minus 5 for the water, so the
// best case for a spread cell is -10. The mission and time bonuses are where
// the points are: contain it early, cleanly, and fast.
const REWARD = {
  extinguish: 25,
  waterDump: -5,
  infrastructureHit: -400,
  remainingFire: -50,
  winBonus: 750,
  perSecondLeft: 3,
};

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// ---------- DOM ----------

const $ = (selector) => document.querySelector(selector);
const el = {
  terrain: $("#terrain"),
  unitLayer: $("#unitLayer"),
  droneUnit: $("#droneUnit"),
  roverUnit: $("#roverUnit"),
  timeLeft: $("#timeLeft"),
  score: $("#score"),
  scoreDelta: $("#scoreDelta"),
  markedFires: $("#markedFires"),
  sightedFires: $("#sightedFires"),
  waterUsed: $("#waterUsed"),
  infraHit: $("#infraHit"),
  dronePosition: $("#dronePosition"),
  roverPosition: $("#roverPosition"),
  droneMode: $("#droneMode"),
  roverMode: $("#roverMode"),
  log: $("#eventLog"),
  startBtn: $("#startBtn"),
  resetBtn: $("#resetBtn"),
  autoPerceptionBtn: $("#autoPerceptionBtn"),
  autoActionBtn: $("#autoActionBtn"),
  bestLine: $("#bestLine"),
  recordLine: $("#recordLine"),
  summary: $("#summary"),
  summaryTitle: $("#summaryTitle"),
  summaryBody: $("#summaryBody"),
  summaryNewBtn: $("#summaryNewBtn"),
  summaryClose: $("#summaryClose"),
};
const difficultyButtons = [...document.querySelectorAll(".difficulty")];

// ---------- Module state ----------

let difficulty = "easy";
const automation = { drone: false, rover: false };
const held = { drone: [], rover: [] };
let state = null;
let loopId = null;
let cellEls = [];
let store = loadStore();

const pinnedSeed = (() => {
  const raw = new URLSearchParams(window.location.search).get("seed");
  return raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
})();

// ---------- Small utilities ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSeed() {
  return Math.floor(Math.random() * 1e9);
}

function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function idx(x, y) {
  return y * state.size + x;
}

function xy(i) {
  const x = i % state.size;
  return { x, y: (i - x) / state.size };
}

function inside(x, y) {
  return x >= 0 && y >= 0 && x < state.size && y < state.size;
}

function neighborsOf(i) {
  const { x, y } = xy(i);
  const out = [];
  for (const [dx, dy] of DIRS) {
    if (inside(x + dx, y + dy)) out.push(idx(x + dx, y + dy));
  }
  return out;
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function cellLabel(i) {
  const { x, y } = xy(i);
  return `${x + 1},${y + 1}`;
}

function formatPoints(points) {
  return `${points > 0 ? "+" : ""}${points.toLocaleString()}`;
}

// ---------- Terrain generation ----------

function generateTerrain(config, rng) {
  const size = config.size;
  const n = size * size;
  const protectedCells = new Set();
  for (const [sx, sy] of [
    [0, 0],
    [size - 1, size - 1],
  ]) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = sx + dx;
        const y = sy + dy;
        if (x >= 0 && y >= 0 && x < size && y < size) protectedCells.add(y * size + x);
      }
    }
  }

  const want = (fraction) => Math.round(n * fraction);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const terrain = new Array(n).fill("grass");
    growBlobs(terrain, "mountain", want(config.terrain.mountain), 3, 6, rng, size, protectedCells);
    growBlobs(terrain, "lake", want(config.terrain.lake), 3, 7, rng, size, protectedCells);
    growBlobs(terrain, "tree", want(config.terrain.tree), 4, 9, rng, size, protectedCells);
    placeBuildings(terrain, config.terrain.buildings, rng, size, protectedCells);
    if (terrainIsConnected(terrain, size)) return terrain;
  }
  return new Array(n).fill("grass");
}

function growBlobs(terrain, type, target, minLen, maxLen, rng, size, protectedCells) {
  let placed = 0;
  let guard = 0;
  while (placed < target && guard < 600) {
    guard += 1;
    let i = Math.floor(rng() * terrain.length);
    if (terrain[i] !== "grass" || protectedCells.has(i)) continue;
    const length = minLen + Math.floor(rng() * (maxLen - minLen + 1));
    for (let step = 0; step < length && placed < target; step += 1) {
      if (terrain[i] === "grass" && !protectedCells.has(i)) {
        terrain[i] = type;
        placed += 1;
      }
      const x = i % size;
      const y = (i - x) / size;
      const [dx, dy] = DIRS[Math.floor(rng() * DIRS.length)];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) break;
      i = ny * size + nx;
    }
  }
}

function placeBuildings(terrain, count, rng, size, protectedCells) {
  const placed = [];
  let guard = 0;
  while (placed.length < count && guard < 500) {
    guard += 1;
    let i;
    if (placed.length > 0 && rng() < 0.7) {
      // cluster: near an existing building, like a small settlement
      const anchor = placed[Math.floor(rng() * placed.length)];
      const ax = anchor % size;
      const ay = (anchor - ax) / size;
      const x = ax + Math.floor(rng() * 5) - 2;
      const y = ay + Math.floor(rng() * 5) - 2;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      i = y * size + x;
    } else {
      i = Math.floor(rng() * terrain.length);
    }
    if (terrain[i] !== "grass" || protectedCells.has(i)) continue;
    terrain[i] = "building";
    placed.push(i);
  }
}

// Every burnable cell must be reachable by the action robot, and every
// non-mountain cell by the perception robot; otherwise a fire could be
// impossible to put out.
function terrainIsConnected(terrain, size) {
  const n = size * size;
  const reach = (start, canCross) => {
    const seen = new Uint8Array(n);
    const queue = [start];
    seen[start] = 1;
    for (let head = 0; head < queue.length; head += 1) {
      const cur = queue[head];
      const cx = cur % size;
      const cy = (cur - cx) / size;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const ni = ny * size + nx;
        if (seen[ni] || !canCross(terrain[ni])) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
    return seen;
  };
  const roverSeen = reach(n - 1, ROBOTS.rover.canCross);
  const droneSeen = reach(0, ROBOTS.drone.canCross);
  for (let i = 0; i < n; i += 1) {
    const type = terrain[i];
    if (TERRAIN[type].burnable && !roverSeen[i]) return false;
    if (type !== "mountain" && !droneSeen[i]) return false;
  }
  return true;
}

// ---------- Mission setup ----------

function setupMission(nextDifficulty = difficulty, seed = pinnedSeed ?? randomSeed()) {
  stopLoop();
  difficulty = nextDifficulty;
  const config = DIFFICULTIES[difficulty];
  const size = config.size;
  const rng = mulberry32(seed);

  state = {
    config,
    size,
    seed,
    rng,
    terrain: generateTerrain(config, rng),
    elapsedMs: 0,
    lastSpreadAt: 0,
    lastFogPaintAt: 0,
    dirty: true,
    started: false,
    finished: false,
    won: false,
    drone: { x: 0, y: 0, nextMoveAt: 0, nextActAt: 0, target: -1, pendingTap: null, pendingAct: false, lastBlockedLogAt: -Infinity },
    rover: { x: size - 1, y: size - 1, nextMoveAt: 0, nextActAt: 0, target: -1, pendingTap: null, pendingAct: false, lastBlockedLogAt: -Infinity },
    fires: new Map(), // cell -> remaining water dumps
    marked: new Set(),
    markedAt: new Map(),
    belief: new Map(), // cell -> { fire, at }
    extinguished: new Set(),
    spreadCells: new Set(),
    chargedBurn: new Set(),
    infraHit: new Set(),
    waterUsed: 0,
    extinguishedCount: 0,
    score: 0,
    breakdown: { extinguish: 0, water: 0, burn: 0, infra: 0, remaining: 0, time: 0, win: 0 },
    log: [],
  };
  held.drone = [];
  held.rover = [];

  seedFires();
  observeCell(idx(0, 0));
  observeCell(idx(size - 1, size - 1));

  buildBoard();
  difficultyButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.difficulty === difficulty);
  });
  el.startBtn.disabled = false;
  el.startBtn.textContent = "Start Mission";
  hideSummary();
  renderAutomationButtons();
  logEvent(`${config.label} mission ready. Map #${seed}.`, "info");
  saveSettings();
  render(true);
}

function seedFires() {
  const { size, config, terrain, rng } = state;
  const corners = [
    { x: 0, y: 0 },
    { x: size - 1, y: size - 1 },
  ];
  const minDist = size <= 9 ? 3 : 4;
  const candidates = (relaxed) => {
    const out = [];
    for (let i = 0; i < size * size; i += 1) {
      const type = terrain[i];
      if (type !== "grass" && type !== "tree") continue;
      const p = xy(i);
      if (corners.some((c) => manhattan(c, p) < minDist)) continue;
      if (!relaxed && neighborsOf(i).some((n) => terrain[n] === "building")) continue;
      out.push(i);
    }
    return out;
  };
  let pool = candidates(false);
  if (pool.length < config.initialFires) pool = candidates(true);
  shuffle(pool, rng);
  for (let k = 0; k < Math.min(config.initialFires, pool.length); k += 1) {
    igniteCell(pool[k], false);
  }
}

function startMission() {
  if (!state || state.started || state.finished) return;
  state.started = true;
  el.startBtn.disabled = true;
  el.startBtn.textContent = "Mission running";
  hideSummary();
  logEvent(`${state.config.label} mission active.`, "info");
  loopId = setInterval(loop, TICK_MS);
  render(true);
}

function stopLoop() {
  if (loopId !== null) {
    clearInterval(loopId);
    loopId = null;
  }
}

// ---------- Simulation loop ----------

function loop() {
  if (!state.started || state.finished) return;
  state.elapsedMs += TICK_MS;

  if (state.elapsedMs >= state.config.seconds * 1000) {
    endGame(false);
    return;
  }

  if (state.elapsedMs - state.lastSpreadAt >= state.config.spreadEveryMs) {
    state.lastSpreadAt = state.elapsedMs;
    spreadFire();
  }

  runRobot("drone");
  if (state.finished) return;
  runRobot("rover");
  if (state.finished) return;

  if (state.dirty || state.elapsedMs - state.lastFogPaintAt >= FOG_REPAINT_MS) {
    render(false);
  }
}

function runRobot(name) {
  if (automation[name]) {
    if (name === "drone") runPerceptionPolicy();
    else runActionPolicy();
    return;
  }
  const robot = state[name];
  const now = state.elapsedMs;
  if (robot.pendingAct && now >= robot.nextActAt) {
    robot.pendingAct = false;
    if (name === "drone") markFire();
    else extinguishFire();
    if (state.finished) return;
  }
  const dirs = held[name];
  if (dirs.length > 0) {
    robot.pendingTap = null;
    const dir = dirs[dirs.length - 1];
    tryMove(name, dir.dx, dir.dy);
    return;
  }
  if (robot.pendingTap && now >= robot.nextMoveAt) {
    const tap = robot.pendingTap;
    robot.pendingTap = null;
    tryMove(name, tap.dx, tap.dy);
  }
}

// ---------- World mechanics ----------

function igniteCell(i, bySpread) {
  const type = state.terrain[i];
  state.fires.set(i, TERRAIN[type].fireHp);
  if (bySpread) state.spreadCells.add(i);
  if (type === "building" && !state.infraHit.has(i)) {
    // buildings have alarms: the hit is known immediately and marked for the action robot
    state.infraHit.add(i);
    state.marked.add(i);
    state.markedAt.set(i, state.elapsedMs);
    state.belief.set(i, { fire: true, at: state.elapsedMs });
    addScore(REWARD.infrastructureHit, "infra", "Infrastructure hit");
    logEvent(`ALARM — fire reached a building at ${cellLabel(i)}.`, "alert");
    if (bySpread) chargeBurn(i);
  }
  state.dirty = true;
}

function spreadFire() {
  const { fires, terrain, rng, config, extinguished } = state;
  const targets = [];
  for (const [i] of fires) {
    const chance = config.spreadChance * TERRAIN[terrain[i]].spreadMult;
    if (rng() > chance) continue;
    const options = neighborsOf(i);
    const target = options[Math.floor(rng() * options.length)];
    if (!TERRAIN[terrain[target]].burnable) continue; // mountains, lakes are firebreaks
    if (fires.has(target) || extinguished.has(target)) continue; // burnt ground does not reignite
    targets.push(target);
  }
  for (const target of targets) {
    if (!fires.has(target)) igniteCell(target, true);
  }
  if (targets.length > 0) {
    observeCell(idx(state.drone.x, state.drone.y));
    state.dirty = true;
  }
}

function confidence(i) {
  const b = state.belief.get(i);
  if (!b) return 0;
  return Math.pow(0.5, (state.elapsedMs - b.at) / state.config.memoryHalfLifeMs);
}

function observeCell(i) {
  if (!TERRAIN[state.terrain[i]].burnable) return;
  const onFire = state.fires.has(i);
  const prev = state.belief.get(i);
  state.belief.set(i, { fire: onFire, at: state.elapsedMs });
  if (onFire && !state.marked.has(i) && !(prev && prev.fire && confidence(i) > FRESH_CONFIDENCE)) {
    logEvent(`Thermal spike detected at ${cellLabel(i)}.`, "info");
  }
  if (onFire && state.spreadCells.has(i)) chargeBurn(i);
  state.dirty = true;
}

function chargeBurn(i) {
  if (state.chargedBurn.has(i)) return;
  state.chargedBurn.add(i);
  const points = -TERRAIN[state.terrain[i]].burnPenalty;
  if (state.finished) {
    state.breakdown.burn += points;
    state.score += points;
  } else {
    addScore(points, "burn", "Spread damage found");
  }
}

function tryMove(name, dx, dy) {
  const robot = state[name];
  const now = state.elapsedMs;
  if (now < robot.nextMoveAt) return false;
  const x = robot.x + dx;
  const y = robot.y + dy;
  if (!inside(x, y)) return false;
  const type = state.terrain[idx(x, y)];
  if (!ROBOTS[name].canCross(type)) {
    robot.nextMoveAt = now + ROBOTS[name].moveEveryMs;
    if (!automation[name] && now - robot.lastBlockedLogAt > 900) {
      robot.lastBlockedLogAt = now;
      logEvent(`${TERRAIN[type].label} blocks the ${ROBOTS[name].label}.`, "info");
    }
    return false;
  }
  robot.x = x;
  robot.y = y;
  robot.nextMoveAt = now + ROBOTS[name].moveEveryMs;
  if (name === "drone") observeCell(idx(x, y));
  state.dirty = true;
  return true;
}

function markFire() {
  const d = state.drone;
  if (state.elapsedMs < d.nextActAt) return;
  d.nextActAt = state.elapsedMs + ROBOTS.drone.actEveryMs;
  const i = idx(d.x, d.y);
  if (!state.fires.has(i)) {
    logEvent("No fire signature here for the perception robot to mark.", "info");
    return;
  }
  if (state.marked.has(i)) {
    logEvent("Already marked.", "info");
    return;
  }
  state.marked.add(i);
  state.markedAt.set(i, state.elapsedMs);
  observeCell(i);
  logEvent(`Fire marked at ${cellLabel(i)}.`, "info");
  state.dirty = true;
}

function extinguishFire() {
  const r = state.rover;
  if (state.elapsedMs < r.nextActAt) return;
  r.nextActAt = state.elapsedMs + ROBOTS.rover.actEveryMs;
  const i = idx(r.x, r.y);
  if (!state.fires.has(i)) {
    logEvent("No marked fire under the action robot.", "info");
    return;
  }
  if (!state.marked.has(i)) {
    logEvent("The action robot is blind here — the perception robot must mark this fire first.", "info");
    return;
  }
  state.waterUsed += 1;
  addScore(REWARD.waterDump, "water", "Water dump");
  const hp = state.fires.get(i) - 1;
  if (hp > 0) {
    state.fires.set(i, hp);
    logEvent("Tree fire suppressed partially — one more dump.", "info");
    state.dirty = true;
    return;
  }
  state.fires.delete(i);
  state.marked.delete(i);
  state.markedAt.delete(i);
  state.extinguished.add(i);
  state.belief.set(i, { fire: false, at: state.elapsedMs });
  state.extinguishedCount += 1;
  addScore(REWARD.extinguish, "extinguish", "Fire knocked down");
  logEvent(`Fire knocked down at ${cellLabel(i)}.`, "score");
  state.dirty = true;
  if (state.fires.size === 0) endGame(true);
}

function addScore(points, bucket, label) {
  state.score += points;
  state.breakdown[bucket] += points;
  flashScore(points, label);
}

function endGame(won) {
  state.finished = true;
  state.won = won;
  stopLoop();
  held.drone = [];
  held.rover = [];

  for (const i of state.spreadCells) chargeBurn(i); // damage never discovered still counts

  if (won) {
    const secondsLeft = Math.max(0, Math.floor((state.config.seconds * 1000 - state.elapsedMs) / 1000));
    state.breakdown.win = REWARD.winBonus;
    state.breakdown.time = secondsLeft * REWARD.perSecondLeft;
    state.score += state.breakdown.win + state.breakdown.time;
  } else {
    state.breakdown.remaining = state.fires.size * REWARD.remainingFire;
    state.score += state.breakdown.remaining;
  }

  const isRecord = updateRecords(won);
  logEvent(won ? "All fires out. Mission complete." : "Time expired. The fire is still burning.", won ? "win" : "lose");
  el.startBtn.textContent = "Mission over";
  render(true);
  showSummary(isRecord);
}

// ---------- Pathfinding ----------

function bfs(name, fromIdx) {
  const { size, terrain } = state;
  const n = size * size;
  const dist = new Int16Array(n).fill(-1);
  const parent = new Int16Array(n).fill(-1);
  const canCross = ROBOTS[name].canCross;
  const queue = [fromIdx];
  dist[fromIdx] = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const cur = queue[head];
    const cx = cur % size;
    const cy = (cur - cx) / size;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const ni = ny * size + nx;
      if (dist[ni] !== -1 || !canCross(terrain[ni])) continue;
      dist[ni] = dist[cur] + 1;
      parent[ni] = cur;
      queue.push(ni);
    }
  }
  return { dist, parent };
}

function firstStep(parent, fromIdx, targetIdx) {
  if (targetIdx < 0 || targetIdx === fromIdx) return null;
  let cur = targetIdx;
  while (parent[cur] !== fromIdx) {
    cur = parent[cur];
    if (cur < 0) return null;
  }
  const from = xy(fromIdx);
  const next = xy(cur);
  return { dx: next.x - from.x, dy: next.y - from.y };
}

// ---------- Automation policies ----------
// Both policies only use what the robot is entitled to know: the belief
// map, marked fires, and the fire status of the perception robot's own cell.

function runPerceptionPolicy() {
  const d = state.drone;
  const here = idx(d.x, d.y);
  const now = state.elapsedMs;
  if (state.fires.has(here) && !state.marked.has(here)) {
    if (now >= d.nextActAt) markFire();
    return;
  }
  if (now < d.nextMoveAt) return;
  const { dist, parent } = bfs("drone", here);
  const target = choosePerceptionTarget(here, dist);
  const step = firstStep(parent, here, target);
  if (step) tryMove("drone", step.dx, step.dy);
}

function choosePerceptionTarget(here, dist) {
  const { size, terrain } = state;
  const d = state.drone;
  const fireCells = [];
  for (const i of state.marked) fireCells.push(xy(i));
  for (const [i, b] of state.belief) {
    if (b.fire && !state.marked.has(i)) fireCells.push(xy(i));
  }

  let best = -1;
  let bestScore = Infinity;
  let currentScore = Infinity;
  for (let i = 0; i < size * size; i += 1) {
    if (i === here || dist[i] < 0) continue;
    if (!TERRAIN[terrain[i]].burnable || state.extinguished.has(i) || state.marked.has(i)) continue;
    const conf = confidence(i);
    const staleness = 1 - conf;
    const b = state.belief.get(i);
    const sightedUnmarked = Boolean(b && b.fire && conf > SIGHTED_CONFIDENCE);
    const p = xy(i);
    let risk = 0;
    for (const f of fireCells) {
      const dd = manhattan(f, p);
      if (dd < 5) risk = Math.max(risk, (5 - dd) / 5);
    }
    const score = dist[i] - 8 * staleness - 6 * risk * (0.3 + staleness) - (sightedUnmarked ? 100 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
    if (i === d.target) currentScore = score;
  }
  // hysteresis: keep the current target unless something is clearly better
  if (d.target >= 0 && currentScore <= bestScore + 3) return d.target;
  d.target = best;
  return best;
}

function runActionPolicy() {
  const r = state.rover;
  const here = idx(r.x, r.y);
  const now = state.elapsedMs;
  if (state.marked.has(here) && state.fires.has(here)) {
    if (now >= r.nextActAt) extinguishFire();
    return;
  }
  if (now < r.nextMoveAt) return;
  const { dist, parent } = bfs("rover", here);
  let target = chooseActionTarget(dist);
  if (target < 0) target = chooseStagingTarget(dist);
  const step = firstStep(parent, here, target);
  if (step) tryMove("rover", step.dx, step.dy);
}

function chooseActionTarget(dist) {
  let best = -1;
  let bestScore = Infinity;
  for (const i of state.marked) {
    if (dist[i] < 0) continue;
    const cluster = neighborsOf(i).filter((n) => state.marked.has(n)).length;
    const ageSeconds = (state.elapsedMs - (state.markedAt.get(i) ?? state.elapsedMs)) / 1000;
    const isBuilding = state.terrain[i] === "building" ? 4 : 0;
    const threatensBuilding = neighborsOf(i).some(
      (n) => state.terrain[n] === "building" && !state.fires.has(n) && !state.extinguished.has(n),
    )
      ? 2.5
      : 0;
    const score = dist[i] - 1.5 * cluster - 0.05 * Math.min(ageSeconds, 20) - isBuilding - threatensBuilding;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

// With nothing marked, shadow the perception robot so the response is short
// once it finds something.
function chooseStagingTarget(dist) {
  const r = state.rover;
  const d = state.drone;
  if (manhattan(r, d) <= 3) return -1;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < state.size * state.size; i += 1) {
    if (dist[i] < 0) continue;
    const score = manhattan(xy(i), d) + dist[i] * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

// ---------- Persistence ----------

function loadStore() {
  const empty = { best: {}, played: 0, won: 0, settings: {} };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { ...empty, ...parsed, best: parsed.best || {}, settings: parsed.settings || {} };
    }
  } catch (_error) {
    /* storage unavailable or corrupt: play without records */
  }
  return empty;
}

function persist() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (_error) {
    /* ignore: private mode or quota */
  }
}

function modeKey() {
  return `${difficulty}:${automation.drone ? "P" : "-"}${automation.rover ? "A" : "-"}`;
}

function modeDescription() {
  const p = automation.drone ? "P auto" : "P manual";
  const a = automation.rover ? "A auto" : "A manual";
  return `${DIFFICULTIES[difficulty].label} · ${p} · ${a}`;
}

function saveSettings() {
  store.settings = { difficulty, autoPerception: automation.drone, autoAction: automation.rover };
  persist();
}

function updateRecords(won) {
  store.played += 1;
  if (won) store.won += 1;
  const key = modeKey();
  const prev = store.best[key] || null;
  const clearSeconds = won ? Math.round(state.elapsedMs / 1000) : null;
  let isRecord = false;
  const next = prev ? { ...prev } : { score: -Infinity, fastest: null };
  if (state.score > next.score) {
    next.score = state.score;
    isRecord = true;
  }
  if (clearSeconds !== null && (next.fastest === null || clearSeconds < next.fastest)) {
    next.fastest = clearSeconds;
  }
  next.at = Date.now();
  store.best[key] = next;
  persist();
  return isRecord;
}

// ---------- Rendering ----------

function span(className) {
  const node = document.createElement("span");
  node.className = className;
  return node;
}

function buildBoard() {
  const { size, terrain } = state;
  el.terrain.style.setProperty("--size", size);
  el.unitLayer.style.setProperty("--size", size);
  el.terrain.innerHTML = "";
  cellEls = [];
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < size * size; i += 1) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.type = terrain[i];
    const fog = span("fog");
    cell.append(span("glyph"), span("fire"), span("ash"), fog);
    fragment.append(cell);
    cellEls.push({ cell, fog });
  }
  el.terrain.append(fragment);
}

function render(full) {
  renderStats();
  renderBoard();
  renderUnits();
  renderLog();
  if (full) renderRecords();
  state.dirty = false;
  state.lastFogPaintAt = state.elapsedMs;
}

function renderBoard() {
  const { terrain, finished } = state;
  for (let i = 0; i < cellEls.length; i += 1) {
    const { cell, fog } = cellEls[i];
    const type = terrain[i];
    const burnable = TERRAIN[type].burnable;
    const onFire = state.fires.has(i);
    const marked = state.marked.has(i);
    const ash = state.extinguished.has(i);
    const conf = burnable && !finished && !marked && !ash ? confidence(i) : 1;
    const b = state.belief.get(i);
    const showFire = finished ? onFire : marked || Boolean(b && b.fire && conf > SIGHTED_CONFIDENCE);

    cell.classList.toggle("on-fire", showFire);
    cell.classList.toggle("marked", showFire && marked);
    cell.classList.toggle("sighted", showFire && !marked);
    cell.classList.toggle("weakened", showFire && type === "tree" && state.fires.get(i) === 1 && (marked || finished));
    cell.classList.toggle("ash", ash);
    cell.classList.toggle("revealed", finished);
    cell.style.setProperty("--fire-opacity", showFire ? (marked || finished ? "1" : (0.3 + 0.7 * conf).toFixed(2)) : "0");
    // terrain is known from the map; only fire status is uncertain, so fog never fully hides a cell
    fog.style.opacity = burnable && !finished ? (0.78 * (1 - conf)).toFixed(2) : "0";
  }
}

function renderUnits() {
  const { drone, rover } = state;
  const sameCell = drone.x === rover.x && drone.y === rover.y;
  el.droneUnit.style.setProperty("--x", drone.x);
  el.droneUnit.style.setProperty("--y", drone.y);
  el.roverUnit.style.setProperty("--x", rover.x);
  el.roverUnit.style.setProperty("--y", rover.y);
  el.droneUnit.classList.toggle("same-cell", sameCell);
  el.roverUnit.classList.toggle("same-cell", sameCell);
}

function sightedCount() {
  if (state.finished) return 0;
  let count = 0;
  for (const [i, b] of state.belief) {
    if (b.fire && !state.marked.has(i) && confidence(i) > SIGHTED_CONFIDENCE) count += 1;
  }
  return count;
}

function renderStats() {
  const msLeft = Math.max(0, state.config.seconds * 1000 - state.elapsedMs);
  const secondsLeft = Math.ceil(msLeft / 1000);
  const minutes = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const seconds = String(secondsLeft % 60).padStart(2, "0");
  el.timeLeft.textContent = `${minutes}:${seconds}`;
  el.score.textContent = state.score.toLocaleString();
  el.score.classList.toggle("negative", state.score < 0);
  el.markedFires.textContent = state.marked.size;
  el.sightedFires.textContent = sightedCount();
  el.waterUsed.textContent = state.waterUsed;
  el.infraHit.textContent = state.infraHit.size;
  el.infraHit.classList.toggle("alert", state.infraHit.size > 0);
  el.dronePosition.textContent = `${state.drone.x + 1},${state.drone.y + 1}`;
  el.roverPosition.textContent = `${state.rover.x + 1},${state.rover.y + 1}`;
  el.droneMode.textContent = automation.drone ? "auto" : "manual";
  el.roverMode.textContent = automation.rover ? "auto" : "manual";
  el.droneMode.classList.toggle("auto", automation.drone);
  el.roverMode.classList.toggle("auto", automation.rover);
}

function renderAutomationButtons() {
  el.autoPerceptionBtn.classList.toggle("active", automation.drone);
  el.autoPerceptionBtn.setAttribute("aria-pressed", String(automation.drone));
  el.autoActionBtn.classList.toggle("active", automation.rover);
  el.autoActionBtn.setAttribute("aria-pressed", String(automation.rover));
}

function renderRecords() {
  const best = store.best[modeKey()];
  if (best) {
    const fastest = best.fastest !== null && best.fastest !== undefined ? ` · fastest clear ${best.fastest}s` : "";
    el.bestLine.textContent = `Best (${modeDescription()}): ${best.score.toLocaleString()} pts${fastest}`;
  } else {
    el.bestLine.textContent = `No record yet for ${modeDescription()}.`;
  }
  el.recordLine.textContent = `Missions won: ${store.won} / ${store.played}`;
}

function logEvent(text, kind) {
  state.log.unshift({ text, kind });
  if (state.log.length > 40) state.log.length = 40;
  state.dirty = true;
}

function renderLog() {
  const lines = state.log.slice(0, LOG_LINES);
  el.log.innerHTML = "";
  for (const line of lines) {
    const item = document.createElement("li");
    item.className = line.kind;
    item.textContent = line.text;
    el.log.append(item);
  }
}

function flashScore(points, label) {
  const node = el.scoreDelta;
  node.textContent = formatPoints(points);
  node.title = label;
  node.classList.remove("pop", "gain", "loss");
  void node.offsetWidth; // restart the animation
  node.classList.add("pop", points > 0 ? "gain" : "loss");
}

function showSummary(isRecord) {
  const { breakdown, config } = state;
  const won = state.won;
  el.summaryTitle.textContent = won ? "Mission complete" : "Mission failed";
  el.summaryTitle.className = won ? "win" : "lose";

  const rows = [
    ["Fires knocked down", state.extinguishedCount, breakdown.extinguish],
    ["Water dumps", state.waterUsed, breakdown.water],
    ["Spread damage", `${state.spreadCells.size} cells`, breakdown.burn],
    ["Infrastructure hit", state.infraHit.size, breakdown.infra],
  ];
  if (won) {
    const secondsLeft = Math.round(breakdown.time / REWARD.perSecondLeft);
    rows.push(["Mission bonus", "", breakdown.win]);
    rows.push(["Time bonus", `${secondsLeft}s left`, breakdown.time]);
  } else {
    rows.push(["Fires still burning", state.fires.size, breakdown.remaining]);
  }

  const table = document.createElement("table");
  table.className = "summary-table";
  for (const [label, detail, points] of rows) {
    const tr = document.createElement("tr");
    const tdLabel = document.createElement("td");
    tdLabel.textContent = detail === "" ? label : `${label} (${detail})`;
    const tdPoints = document.createElement("td");
    tdPoints.textContent = formatPoints(points);
    tdPoints.className = points > 0 ? "gain" : points < 0 ? "loss" : "";
    tr.append(tdLabel, tdPoints);
    table.append(tr);
  }
  const total = document.createElement("tr");
  total.className = "total";
  const totalLabel = document.createElement("td");
  totalLabel.textContent = "Score";
  const totalPoints = document.createElement("td");
  totalPoints.textContent = state.score.toLocaleString();
  total.append(totalLabel, totalPoints);
  table.append(total);

  const intro = document.createElement("p");
  intro.textContent = won
    ? `${modeDescription()} · cleared in ${Math.round(state.elapsedMs / 1000)}s`
    : `${modeDescription()} · the board now shows every fire.`;

  const note = document.createElement("p");
  note.className = `summary-note${isRecord ? " record" : ""}`;
  const best = store.best[modeKey()];
  note.textContent = isRecord
    ? `New best score for this setup.`
    : best
      ? `Best for this setup: ${best.score.toLocaleString()} pts.`
      : "";

  const replay = document.createElement("p");
  replay.className = "summary-note";
  const link = document.createElement("a");
  link.href = `?seed=${state.seed}`;
  link.textContent = `Replay map #${state.seed}`;
  replay.append(link);

  el.summaryBody.innerHTML = "";
  el.summaryBody.append(intro, table, note, replay);
  el.summary.hidden = false;
}

function hideSummary() {
  el.summary.hidden = true;
}

// ---------- Input ----------

const KEYMAP = {
  ArrowUp: ["drone", 0, -1],
  ArrowDown: ["drone", 0, 1],
  ArrowLeft: ["drone", -1, 0],
  ArrowRight: ["drone", 1, 0],
  KeyW: ["rover", 0, -1],
  KeyS: ["rover", 0, 1],
  KeyA: ["rover", -1, 0],
  KeyD: ["rover", 1, 0],
};

window.addEventListener("keydown", (event) => {
  const code = event.code;
  if (KEYMAP[code] || code === "ShiftLeft" || code === "ShiftRight") event.preventDefault();

  if (code === "Enter" && state && !state.started && !state.finished && document.activeElement === document.body) {
    startMission();
    return;
  }
  if (event.repeat || !state || !state.started || state.finished) return;

  // Actions and taps that land inside a cooldown are queued, never dropped.
  if (code === "ShiftRight") {
    if (automation.drone) return;
    if (state.elapsedMs >= state.drone.nextActAt) markFire();
    else state.drone.pendingAct = true;
    return;
  }
  if (code === "ShiftLeft") {
    if (automation.rover) return;
    if (state.elapsedMs >= state.rover.nextActAt) extinguishFire();
    else state.rover.pendingAct = true;
    return;
  }

  const mapping = KEYMAP[code];
  if (!mapping) return;
  const [name, dx, dy] = mapping;
  if (automation[name]) return;
  const list = held[name];
  const existing = list.findIndex((h) => h.code === code);
  if (existing >= 0) list.splice(existing, 1);
  list.push({ code, dx, dy });
  // a tap moves right away; holding continues at the robot's cadence
  if (state.elapsedMs >= state[name].nextMoveAt) tryMove(name, dx, dy);
  else state[name].pendingTap = { dx, dy };
});

window.addEventListener("keyup", (event) => {
  const mapping = KEYMAP[event.code];
  if (!mapping) return;
  const list = held[mapping[0]];
  const existing = list.findIndex((h) => h.code === event.code);
  if (existing >= 0) list.splice(existing, 1);
});

window.addEventListener("blur", () => {
  held.drone = [];
  held.rover = [];
});

el.startBtn.addEventListener("click", startMission);
el.resetBtn.addEventListener("click", () => setupMission());
el.summaryNewBtn.addEventListener("click", () => setupMission());
el.summaryClose.addEventListener("click", hideSummary);

el.autoPerceptionBtn.addEventListener("click", () => {
  automation.drone = !automation.drone;
  held.drone = [];
  state.drone.target = -1;
  state.drone.pendingTap = null;
  state.drone.pendingAct = false;
  renderAutomationButtons();
  saveSettings();
  render(true);
});

el.autoActionBtn.addEventListener("click", () => {
  automation.rover = !automation.rover;
  held.rover = [];
  state.rover.target = -1;
  state.rover.pendingTap = null;
  state.rover.pendingAct = false;
  renderAutomationButtons();
  saveSettings();
  render(true);
});

difficultyButtons.forEach((button) => {
  button.addEventListener("click", () => setupMission(button.dataset.difficulty));
});

// ---------- Boot ----------

(function boot() {
  const settings = store.settings || {};
  if (settings.difficulty && DIFFICULTIES[settings.difficulty]) difficulty = settings.difficulty;
  automation.drone = Boolean(settings.autoPerception);
  automation.rover = Boolean(settings.autoAction);
  setupMission(difficulty);
})();

// Exposed for tests and tinkering (window.FireCommander.state, etc.).
window.FireCommander = {
  get state() {
    return state;
  },
  automation,
  DIFFICULTIES,
  REWARD,
  ROBOTS,
  setupMission,
  startMission,
};
