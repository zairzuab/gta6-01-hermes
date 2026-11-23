// PORT AZUL: Neon Tide — the story jobs.
//
// Five jobs follow Marlow Reyes from Roxy's courier van on the boardwalk to a
// manifest heist at the docks, with Lourdes's drops and Port Azul PD in
// between. Progress (money, respect, rank, best heat, finished jobs) is kept
// in localStorage under one key, and every finished job raises the runner's
// rank toward KINGPIN.
//
// A job is a list of stages; a stage is completed by one of seven objective
// kinds:
//
//   car      get behind the wheel
//   marker   stand inside the yellow beacon (radius PICKUP_RADIUS)
//   marker2  same, blue beacon
//   marker3  same, green beacon
//   ram      land RAM_HITS bumps on the rival courier
//   clean    wanted level back to zero after the run had heat
//   five     raise the wanted level to five stars
//   survive  hold five stars for SURVIVE_SECONDS straight
//
// Only the marker kinds have a world position, so only those get a beacon and
// a distance readout; a "clean" or "five" stage would send the player chasing
// an empty pillar across the map.
import { COAST_Z, streetCoord } from './city.js';

const SAVE_KEY = 'portazul-neontide-save-v1';
const PICKUP_RADIUS = 8;       // metres to count as reaching a beacon
const RAM_HITS = 3;            // bumps that stop the rival courier
const SURVIVE_SECONDS = 60;    // how long five stars must be held
const MAX_RANK = 10;
const RESPECT_PER_JOB = 300;

// ---- the script -------------------------------------------------------------
const JOBS = [
  {
    id: 'first',
    name: 'SALT & STEEL',
    reward: 8000,
    brief: 'Roxy needs the courier van back before the PD impounds it.',
    stages: [
      { name: 'GET ROLLING', obj: 'Get behind the wheel of the Brisa GT.', target: 'car' },
      { name: 'REACH THE VAN', obj: 'Drive to the yellow marker on the Boardwalk and take the van.', target: 'marker', at: [30, COAST_Z + 18] },
      { name: 'DELIVER IT', obj: 'Bring the van to Roxy at the Coral Diner (blue marker).', target: 'marker2', at: [60, 60] },
      { name: 'LOSE THE HEAT', obj: 'Lose the heat — get your wanted level to zero.', target: 'clean' },
    ],
  },
  {
    id: 'delivery',
    name: 'NEON RUN',
    reward: 12000,
    brief: 'A locked case for Lourdes. Three drops, and the PD is already awake.',
    stages: [
      { name: 'PICK UP THE CASE', obj: 'Pick up the case at the yellow marker downtown.', target: 'marker', at: [streetCoord(3), streetCoord(3)] },
      { name: 'DROP ONE', obj: 'Drop it at the first blue marker in Old Town.', target: 'marker2', at: [streetCoord(2), streetCoord(4)] },
      { name: 'DROP TWO', obj: 'Second drop: the gas station on Sunset Boulevard.', target: 'marker3', at: [-150, 150] },
      { name: 'LOSE THE HEAT', obj: 'Lose the heat — get your wanted level to zero.', target: 'clean' },
    ],
  },
  {
    id: 'chase',
    name: 'HIGH TIDE',
    reward: 18000,
    brief: 'A rival crew took the money. Run their courier down.',
    stages: [
      { name: 'FIND THE COURIER', obj: 'Reach the yellow marker and identify the runner.', target: 'marker', at: [30, -60] },
      { name: 'RUN THEM DOWN', obj: 'Ram the runner (the red marker) until it stops.', target: 'ram', at: [30, -120] },
      { name: 'ESCAPE', obj: 'Lose the heat — get your wanted level to zero.', target: 'clean' },
    ],
  },
  {
    id: 'five',
    name: 'FIVE STAR',
    reward: 26000,
    brief: 'The whole city wants you. Raise five stars and stay alive.',
    stages: [
      { name: 'MAKE SOME NOISE', obj: 'Raise your wanted level to 5 stars — steal, ram, shoot.', target: 'five' },
      { name: 'SURVIVE', obj: 'Survive 60 seconds at five stars. The armoured truck is coming.', target: 'survive' },
      { name: 'LOSE THE HEAT', obj: 'Lose the heat — get your wanted level to zero.', target: 'clean' },
    ],
  },
  {
    id: 'port',
    name: 'THE DOCKWORK',
    reward: 40000,
    brief: 'Lourdes wants a shipping manifest off the docks. In and out.',
    stages: [
      { name: 'GET TO THE DOCKS', obj: 'Reach the yellow marker at the Port Authority yard.', target: 'marker', at: [-280, -60] },
      { name: 'GRAB THE MANIFEST', obj: 'Take the manifest from the crane office.', target: 'marker2', at: [-280, -20] },
      { name: 'DELIVER TO ROXY', obj: 'Bring it back to the Coral Diner (blue marker).', target: 'marker3', at: [60, 60] },
      { name: 'LOSE THE HEAT', obj: 'Lose the heat — get your wanted level to zero.', target: 'clean' },
    ],
  },
];

/** "JOB n OF m" — derived from the array, never hand-typed per mission. */
export const MISSIONS = JOBS.map((job, i) => {
  Object.defineProperty(job, 'count', {
    enumerable: true,
    get() { return `JOB ${i + 1} OF ${JOBS.length}`; },
  });
  return job;
});

// ---- beacon look ------------------------------------------------------------
const BEACONS = {
  marker: { color: 0xffd75e, kind: 'pickup' },
  marker2: { color: 0x4da3ff, kind: 'drop' },
  marker3: { color: 0x7dffa8, kind: 'drop' },
  ram: { color: 0xff4d5e, kind: 'ram' },
};
const DEFAULT_BEACON = BEACONS.marker2;

/** How each objective kind is met. `bar` feeds the HUD's stage meter. */
const HANDLERS = {
  car(ctx) { return ctx.inCar; },
  ram(ctx) { return ctx.ramHits >= RAM_HITS; },
  five(ctx) { return ctx.wanted >= 5; },
  clean(ctx) {
    return ctx.wanted === 0 && (ctx.startedClean || ctx.cleanStartWanted === 0);
  },
  survive(ctx) { return false; },   // timed: handled by the runner itself
};

const BARS = {
  car(ctx) { return ctx.inCar ? 1 : 0; },
  ram(ctx) { return Math.min(1, ctx.ramHits / RAM_HITS); },
  five(ctx) { return ctx.wanted / 5; },
  clean(ctx) { return ctx.wanted === 0 ? 1 : 1 - ctx.wanted / 5; },
};

function barFor(stage) {
  return BARS[stage.target] ?? ((ctx) => Math.max(0, 1 - ctx.markerDist / 240));
}

/** True when the objective is a place rather than a state. */
function hasDestination(target) {
  return BEACONS[target] !== undefined;
}

// ---- the saved run ---------------------------------------------------------
function blankSave() {
  return { money: 12400, respect: 0, rank: 1, bestWanted: 0, completed: [] };
}

function readSave(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return blankSave();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return blankSave();
    const num = (v) => (Number.isFinite(v) ? v : null);
    const known = new Set(MISSIONS.map((m) => m.id));
    return {
      money: num(parsed.money) ?? 12400,
      respect: num(parsed.respect) ?? 0,
      rank: num(parsed.rank) ?? 1,
      bestWanted: num(parsed.bestWanted) ?? 0,
      // Drop ids this build does not know: a stale job must not pin the run.
      completed: Array.isArray(parsed.completed)
        ? parsed.completed.filter((id) => known.has(id))
        : [],
    };
  } catch {
    // Storage blocked or the save is unreadable: start the story over.
    return blankSave();
  }
}

function writeSave(key, save) {
  try { localStorage.setItem(key, JSON.stringify(save)); } catch { /* ignore */ }
}

function keepInside(i, n) {
  return Math.max(0, Math.min(n - 1, i));
}

// ===========================================================================
// The runner the game drives once per fixed step.
// ===========================================================================
export class MissionRunner {
  constructor() {
    this.save = readSave(SAVE_KEY);
    this.missionIndex = 0;
    this.stageIndex = 0;
    this.done = false;
    this.marker = null;
    this.surviveTimer = 0;
    // Wanted level on the first update of the current "clean" stage, before
    // its rule can decide anything.
    this.cleanStartWanted = undefined;
    const nextOpen = MISSIONS.findIndex((m) => !this.save.completed.includes(m.id));
    this.setMission(nextOpen === -1 ? MISSIONS.length - 1 : nextOpen);
  }

  static defaultSave() { return blankSave(); }

  persist() { writeSave(SAVE_KEY, this.save); }

  mission() { return MISSIONS[this.missionIndex]; }
  stage() { return this.mission().stages[this.stageIndex]; }

  /** Select a job and clear the stage-side timers that belong to the old one. */
  setMission(i) {
    this.missionIndex = keepInside(i, MISSIONS.length);
    this.stageIndex = 0;
    this.done = false;
    this.surviveTimer = 0;
    this.cleanStartWanted = undefined;
    this.marker = this.beaconFor(this.stage());
  }

  /** The beacon the given stage wants, or null when it has no destination. */
  beaconFor(stage) {
    if (!stage || !hasDestination(stage.target)) return null;
    const style = BEACONS[stage.target] || DEFAULT_BEACON;
    const at = stage.at || [streetCoord(3), streetCoord(3)];
    return { x: at[0], z: at[1], color: style.color, kind: style.kind };
  }

  allDone() { return this.save.completed.length >= MISSIONS.length; }
  get progress() { return this.save.completed.length / MISSIONS.length; }

  /** What job `i` pays — the last job once the story is finished. */
  rewardFor(i) {
    const job = MISSIONS[keepInside(i, MISSIONS.length)];
    return job ? job.reward : 0;
  }

  restartMission() { this.setMission(this.missionIndex); }

  resetSave() {
    this.save = blankSave();
    this.persist();
    this.setMission(0);
  }

  advance() {
    this.stageIndex += 1;
    if (this.stageIndex >= this.mission().stages.length) {
      this.completeMission();
      return 'mission-complete';
    }
    this.cleanStartWanted = undefined;
    this.marker = this.beaconFor(this.stage());
    return 'stage';
  }

  completeMission() {
    const job = this.mission();
    this.save.money += job.reward;
    this.save.respect += RESPECT_PER_JOB;
    if (!this.save.completed.includes(job.id)) this.save.completed.push(job.id);
    this.save.rank = Math.min(MAX_RANK, 1 + this.save.completed.length);
    this.done = true;
    this.persist();
  }

  nextMission() {
    if (this.missionIndex + 1 >= MISSIONS.length) return false;
    this.setMission(this.missionIndex + 1);
    return true;
  }

  /**
   * Feed it the live context once per frame:
   * {inCar, wanted, markerDist, speed, startedClean, ramHits}.
   * Returns 'stage', 'mission-complete', or null when nothing happened.
   */
  update(dt, ctx) {
    const stage = this.stage();
    if (!stage || this.done) return null;

    if (stage.target === 'survive') {
      if (ctx.wanted < 5) {
        // Letting the heat drop starts the clock over: surviving means
        // holding five stars, not having touched them once.
        this.surviveTimer = 0;
      } else {
        this.surviveTimer += dt;
        if (this.surviveTimer >= SURVIVE_SECONDS) return this.advance();
      }
      return null;
    }

    if (stage.target === 'clean' && this.cleanStartWanted === undefined) {
      this.cleanStartWanted = ctx.wanted;
    }

    const handler = HANDLERS[stage.target]
      ?? ((c) => c.markerDist < PICKUP_RADIUS);
    return handler(ctx) ? this.advance() : null;
  }

  /** 0..1 completion of the current stage, for the mission bar. */
  stageProgress(ctx) {
    const stage = this.stage();
    if (!stage) return 1;
    if (stage.target === 'survive') {
      return Math.min(1, this.surviveTimer / SURVIVE_SECONDS);
    }
    return barFor(stage)(ctx);
  }
}
