const terrain = document.querySelector("#terrain");
const timeLeftEl = document.querySelector("#timeLeft");
const knownFiresEl = document.querySelector("#knownFires");
const activeFiresEl = document.querySelector("#activeFires");
const waterUsedEl = document.querySelector("#waterUsed");
const dronePositionEl = document.querySelector("#dronePosition");
const roverPositionEl = document.querySelector("#roverPosition");
const messageEl = document.querySelector("#message");
const startBtn = document.querySelector("#startBtn");
const resetBtn = document.querySelector("#resetBtn");
const autoPerceptionBtn = document.querySelector("#autoPerceptionBtn");
const autoActionBtn = document.querySelector("#autoActionBtn");
const difficultyButtons = [...document.querySelectorAll(".difficulty")];

const DIFFICULTIES = {
  easy: { label: "Easy", size: 9, initialFires: 4, spreadChance: 0.14, seconds: 150 },
  moderate: { label: "Moderate", size: 12, initialFires: 7, spreadChance: 0.22, seconds: 130 },
  hard: { label: "Hard", size: 15, initialFires: 10, spreadChance: 0.33, seconds: 115 },
};

let difficulty = "easy";
let state;
let timerId;
let spreadId;
let automationId;
let automatePerception = false;
let automateAction = false;

function makeKey(x, y) {
  return `${x},${y}`;
}

function parseKey(key) {
  return key.split(",").map(Number);
}

function randomCell(size) {
  return {
    x: Math.floor(Math.random() * size),
    y: Math.floor(Math.random() * size),
  };
}

function setupMission(nextDifficulty = difficulty) {
  clearInterval(timerId);
  clearInterval(spreadId);
  clearInterval(automationId);
  difficulty = nextDifficulty;

  const config = DIFFICULTIES[difficulty];
  state = {
    config,
    timeLeft: config.seconds,
    elapsed: 0,
    started: false,
    drone: { x: 0, y: 0 },
    rover: { x: config.size - 1, y: config.size - 1 },
    fires: new Set(),
    knownFires: new Set(),
    discoveredAt: new Map(),
    scanStep: 0,
    scannedAt: new Map([
      [makeKey(0, 0), 0],
      [makeKey(config.size - 1, config.size - 1), 0],
    ]),
    explored: new Set([makeKey(0, 0), makeKey(config.size - 1, config.size - 1)]),
    extinguished: new Set(),
    waterUsed: 0,
    finished: false,
  };

  seedFires(config);
  setMessage(`${config.label} mission ready.`, "");
  terrain.style.setProperty("--size", config.size);
  difficultyButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.difficulty === difficulty);
  });
  startBtn.disabled = false;
  startBtn.textContent = "Start Mission";
  renderAutomationButtons();

  render();
}

function startMission() {
  if (state.started || state.finished) return;
  state.started = true;
  startBtn.disabled = true;
  startBtn.textContent = "Mission Running";
  setMessage(`${state.config.label} mission active.`, "");
  timerId = setInterval(tick, 1000);
  spreadId = setInterval(spreadFire, 2600);
  automationId = setInterval(runAutomationTick, 180);
  render();
}

function seedFires(config) {
  while (state.fires.size < config.initialFires) {
    const cell = randomCell(config.size);
    const key = makeKey(cell.x, cell.y);
    const occupiedStart = key === makeKey(0, 0) || key === makeKey(config.size - 1, config.size - 1);
    if (!occupiedStart) {
      state.fires.add(key);
    }
  }
}

function tick() {
  if (!state.started || state.finished) return;
  state.timeLeft -= 1;
  state.elapsed += 1;
  if (state.timeLeft <= 0) {
    state.timeLeft = 0;
    endGame(false, "Time expired. The remaining fires kept spreading.");
  }
  renderStats();
}

function spreadFire() {
  if (!state.started || state.finished || state.fires.size === 0) return;

  const newFires = new Set();
  state.fires.forEach((key) => {
    if (Math.random() > state.config.spreadChance) return;
    const [x, y] = parseKey(key);
    const neighbors = [
      { x: x + 1, y },
      { x: x - 1, y },
      { x, y: y + 1 },
      { x, y: y - 1 },
    ].filter((cell) => isInside(cell.x, cell.y));
    if (neighbors.length === 0) return;

    const target = neighbors[Math.floor(Math.random() * neighbors.length)];
    const targetKey = makeKey(target.x, target.y);
    if (!state.extinguished.has(targetKey)) {
      newFires.add(targetKey);
    }
  });

  if (newFires.size > 0) {
    newFires.forEach((key) => state.fires.add(key));
    setMessage("Fire spread through nearby terrain.", "");
    render();
  }
}

function moveRobot(robotName, dx, dy) {
  if (!state.started || state.finished) return;
  const robot = state[robotName];
  const x = robot.x + dx;
  const y = robot.y + dy;
  if (!isInside(x, y)) return;

  robot.x = x;
  robot.y = y;
  if (robotName === "drone") {
    const key = makeKey(x, y);
    state.explored.add(key);
    state.scanStep += 1;
    state.scannedAt.set(key, state.scanStep);
    if (state.fires.has(key) && !state.knownFires.has(key)) {
      setMessage("Thermal spike detected.", "");
    }
  }
  render();
}

function markFire() {
  if (!state.started || state.finished) return;
  const key = makeKey(state.drone.x, state.drone.y);
  if (state.fires.has(key)) {
    state.knownFires.add(key);
    if (!state.discoveredAt.has(key)) {
      state.discoveredAt.set(key, state.elapsed);
    }
    setMessage("Fire marked.", "");
  } else {
    setMessage("No fire signature here for the perception robot to mark.", "");
  }
  render();
}

function extinguishFire() {
  if (!state.started || state.finished) return;
  const key = makeKey(state.rover.x, state.rover.y);
  if (state.fires.has(key) && state.knownFires.has(key)) {
    state.fires.delete(key);
    state.knownFires.delete(key);
    state.discoveredAt.delete(key);
    state.extinguished.add(key);
    state.waterUsed += 1;
    setMessage("Water deployed. Fire knocked down.", "");
    if (state.fires.size === 0) {
      endGame(true, "All fires extinguished. Mission complete.");
      return;
    }
  } else if (state.fires.has(key)) {
    setMessage("The action robot is blind. The quadcopter must mark this fire first.", "");
  } else {
    setMessage("No marked fire under the action robot.", "");
  }
  render();
}

function endGame(won, text) {
  state.finished = true;
  clearInterval(timerId);
  clearInterval(spreadId);
  clearInterval(automationId);
  setMessage(text, won ? "win" : "lose");
  render();
}

function runAutomationTick() {
  if (!state.started || state.finished) return;
  if (automatePerception) {
    runPerceptionPolicy();
  }
  if (automateAction) {
    runActionPolicy();
  }
}

function runPerceptionPolicy() {
  const currentKey = makeKey(state.drone.x, state.drone.y);
  if (state.fires.has(currentKey) && !state.knownFires.has(currentKey)) {
    markFire();
    return;
  }

  const target = choosePerceptionTarget();
  if (!target) return;
  stepToward("drone", target);
}

function runActionPolicy() {
  const currentKey = makeKey(state.rover.x, state.rover.y);
  if (state.knownFires.has(currentKey)) {
    extinguishFire();
    return;
  }

  const target = chooseActionTarget();
  if (!target) return;
  stepToward("rover", target);
}

function choosePerceptionTarget() {
  const hiddenNearKnownFire = [...state.knownFires]
    .flatMap((key) => {
      const [x, y] = parseKey(key);
      return neighborsOf(x, y);
    })
    .filter((cell) => !state.explored.has(makeKey(cell.x, cell.y)));

  if (hiddenNearKnownFire.length > 0) {
    return nearestCell(state.drone, hiddenNearKnownFire);
  }

  const unexplored = allCells().filter((cell) => !state.explored.has(makeKey(cell.x, cell.y)));
  if (unexplored.length === 0) {
    return choosePatrolTarget();
  }

  return unexplored
    .map((cell) => {
      const nearKnown = nearestKnownFireDistance(cell);
      const frontierBonus = neighborsOf(cell.x, cell.y).filter((neighbor) =>
        state.explored.has(makeKey(neighbor.x, neighbor.y)),
      ).length;
      const riskBonus = Number.isFinite(nearKnown) ? Math.max(0, 6 - nearKnown) : 0;
      return {
        cell,
        score: manhattan(state.drone, cell) - frontierBonus * 0.9 - riskBonus * 1.4,
      };
    })
    .sort(compareScoredCells)[0].cell;
}

function choosePatrolTarget() {
  const currentKey = makeKey(state.drone.x, state.drone.y);
  const riskyCells = new Set(
    [...state.knownFires].flatMap((key) => {
      const [x, y] = parseKey(key);
      return [key, ...neighborsOf(x, y).map((cell) => makeKey(cell.x, cell.y))];
    }),
  );

  return allCells()
    .filter((cell) => makeKey(cell.x, cell.y) !== currentKey)
    .map((cell) => {
      const key = makeKey(cell.x, cell.y);
      const lastScanned = state.scannedAt.get(key) ?? -state.config.size * state.config.size;
      const riskBonus = riskyCells.has(key) ? state.config.size : 0;
      return {
        cell,
        score: lastScanned - riskBonus + manhattan(state.drone, cell) * 0.2,
      };
    })
    .sort(compareScoredCells)[0]?.cell ?? null;
}

function chooseActionTarget() {
  if (state.knownFires.size === 0) return null;

  return [...state.knownFires]
    .map((key) => {
      const [x, y] = parseKey(key);
      const cell = { x, y };
      const age = state.elapsed - (state.discoveredAt.get(key) ?? state.elapsed);
      const clusterBonus = neighborsOf(x, y).filter((neighbor) =>
        state.knownFires.has(makeKey(neighbor.x, neighbor.y)),
      ).length;
      return {
        cell,
        score: manhattan(state.rover, cell) - clusterBonus * 1.5 - Math.min(age, 20) * 0.05,
      };
    })
    .sort(compareScoredCells)[0].cell;
}

function nearestCell(from, cells) {
  return cells
    .map((cell) => ({ cell, score: manhattan(from, cell) }))
    .sort(compareScoredCells)[0].cell;
}

function nearestKnownFireDistance(cell) {
  if (state.knownFires.size === 0) return Infinity;
  return Math.min(
    ...[...state.knownFires].map((key) => {
      const [x, y] = parseKey(key);
      return manhattan(cell, { x, y });
    }),
  );
}

function stepToward(robotName, target) {
  const robot = state[robotName];
  const dx = target.x - robot.x;
  const dy = target.y - robot.y;

  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) {
    moveRobot(robotName, Math.sign(dx), 0);
    return;
  }

  if (dy !== 0) {
    moveRobot(robotName, 0, Math.sign(dy));
    return;
  }

  if (dx !== 0) {
    moveRobot(robotName, Math.sign(dx), 0);
  }
}

function allCells() {
  const cells = [];
  for (let y = 0; y < state.config.size; y += 1) {
    for (let x = 0; x < state.config.size; x += 1) {
      cells.push({ x, y });
    }
  }
  return cells;
}

function neighborsOf(x, y) {
  return [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 },
  ].filter((cell) => isInside(cell.x, cell.y));
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function compareScoredCells(a, b) {
  return a.score - b.score || a.cell.y - b.cell.y || a.cell.x - b.cell.x;
}

function isInside(x, y) {
  return x >= 0 && y >= 0 && x < state.config.size && y < state.config.size;
}

function setMessage(text, type) {
  messageEl.textContent = text;
  messageEl.classList.toggle("win", type === "win");
  messageEl.classList.toggle("lose", type === "lose");
}

function renderStats() {
  const minutes = String(Math.floor(state.timeLeft / 60)).padStart(2, "0");
  const seconds = String(state.timeLeft % 60).padStart(2, "0");
  timeLeftEl.textContent = `${minutes}:${seconds}`;
  knownFiresEl.textContent = state.knownFires.size;
  activeFiresEl.textContent = state.fires.size;
  waterUsedEl.textContent = state.waterUsed;
  dronePositionEl.textContent = `${state.drone.x + 1},${state.drone.y + 1}`;
  roverPositionEl.textContent = `${state.rover.x + 1},${state.rover.y + 1}`;
}

function renderAutomationButtons() {
  autoPerceptionBtn.classList.toggle("active", automatePerception);
  autoPerceptionBtn.setAttribute("aria-pressed", String(automatePerception));
  autoActionBtn.classList.toggle("active", automateAction);
  autoActionBtn.setAttribute("aria-pressed", String(automateAction));
}

function render() {
  renderStats();
  terrain.innerHTML = "";

  for (let y = 0; y < state.config.size; y += 1) {
    for (let x = 0; x < state.config.size; x += 1) {
      const key = makeKey(x, y);
      const cell = document.createElement("div");
      const explored = state.explored.has(key);
      const hasDrone = state.drone.x === x && state.drone.y === y;
      const hasRover = state.rover.x === x && state.rover.y === y;

      cell.className = "cell";
      cell.classList.toggle("hidden", !explored);
      cell.classList.toggle("visible", explored);
      cell.classList.toggle("fire", state.fires.has(key));
      cell.classList.toggle("known-fire", state.knownFires.has(key));
      cell.classList.toggle("extinguished", state.extinguished.has(key));
      cell.classList.toggle("same-cell", hasDrone && hasRover);

      if (hasDrone) {
        const unit = document.createElement("div");
        unit.className = "unit drone-unit";
        unit.textContent = "P";
        cell.append(unit);
      }

      if (hasRover) {
        const unit = document.createElement("div");
        unit.className = "unit rover-unit";
        unit.textContent = "A";
        cell.append(unit);
      }

      terrain.append(cell);
    }
  }
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  const handledKeys = [
    "arrowup",
    "arrowdown",
    "arrowleft",
    "arrowright",
    "w",
    "a",
    "s",
    "d",
    "shift",
  ];
  if (handledKeys.includes(key)) {
    event.preventDefault();
  }

  if (!state.started) return;

  if (event.code === "ShiftRight") {
    markFire();
    return;
  }

  if (event.code === "ShiftLeft") {
    extinguishFire();
    return;
  }

  switch (event.key) {
    case "ArrowUp":
      moveRobot("drone", 0, -1);
      break;
    case "ArrowDown":
      moveRobot("drone", 0, 1);
      break;
    case "ArrowLeft":
      moveRobot("drone", -1, 0);
      break;
    case "ArrowRight":
      moveRobot("drone", 1, 0);
      break;
    case "w":
    case "W":
      moveRobot("rover", 0, -1);
      break;
    case "s":
    case "S":
      moveRobot("rover", 0, 1);
      break;
    case "a":
    case "A":
      moveRobot("rover", -1, 0);
      break;
    case "d":
    case "D":
      moveRobot("rover", 1, 0);
      break;
  }
});

startBtn.addEventListener("click", startMission);
resetBtn.addEventListener("click", () => setupMission());

autoPerceptionBtn.addEventListener("click", () => {
  automatePerception = !automatePerception;
  renderAutomationButtons();
});

autoActionBtn.addEventListener("click", () => {
  automateAction = !automateAction;
  renderAutomationButtons();
});

difficultyButtons.forEach((button) => {
  button.addEventListener("click", () => setupMission(button.dataset.difficulty));
});

setupMission();
