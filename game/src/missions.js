// Missions: five story jobs with staged objectives, rewards and a save.
// The story: Marlow Reyes, a courier, works for Roxy at the Coral Diner and
// her aunt Lourdes, while Port Azul PD closes in and a rival crew moves in.
// Progress (money, completed jobs, rank, respect) persists to localStorage.
import { COAST_Z, streetCoord } from './city.js';

const STORY = [
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

// The "JOB n OF m" label is derived from the array, so adding a job cannot
// leave a stale count on the missions that follow it.
export const MISSIONS = STORY.map((m, i) => {
  Object.defineProperty(m, 'count', {
    get: () => `JOB ${i + 1} OF ${STORY.length}`,
    enumerable: true,
  });
  return m;
});

const SAVE_KEY = 'portazul-neontide-save-v1';

export class MissionRunner {
  constructor() {
    this.save = this.loadSave();
    this.missionIndex = 0;
    this.stageIndex = 0;
    this.marker = null;         // {x, z, color, kind}
    this.surviveTimer = 0;
    this.surviveNeed = 60;
    this.ramTarget = null;      // the rival courier car for the chase job
    this.done = false;
    // The wanted level a "lose the heat" stage began at, or undefined until the
    // first update of that stage. See update().
    this.cleanStageStartWanted = undefined;
    // Resume on the first job the save has not finished yet.
    const firstOpen = MISSIONS.findIndex((m) => !this.save.completed.includes(m.id));
    this.setMission(firstOpen === -1 ? MISSIONS.length - 1 : firstOpen);
  }

  loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          // Merge over the defaults: a save written by an older build (or a
          // corrupted one) must not leave `bestWanted` undefined, which would
          // turn the pause screen's best-heat line into "NaN".
          const d = MissionRunner.defaultSave();
          const num = (v) => (Number.isFinite(v) ? v : null);
          return {
            money: num(parsed.money) ?? d.money,
            respect: num(parsed.respect) ?? d.respect,
            rank: num(parsed.rank) ?? d.rank,
            bestWanted: num(parsed.bestWanted) ?? d.bestWanted,
            completed: Array.isArray(parsed.completed)
              ? parsed.completed.filter((id) => MISSIONS.some((m) => m.id === id))
              : [],
          };
        }
      }
    } catch { /* storage unavailable or corrupt: start fresh */ }
    return MissionRunner.defaultSave();
  }

  static defaultSave() {
    return { money: 12400, completed: [], respect: 0, rank: 1, bestWanted: 0 };
  }

  persist() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.save)); } catch { /* ignore */ }
  }

  mission() { return MISSIONS[this.missionIndex]; }
  stage() { return this.mission().stages[this.stageIndex]; }

  setMission(i) {
    this.missionIndex = clampIndex(i, MISSIONS.length);
    this.stageIndex = 0;
    this.done = false;
    this.surviveTimer = 0;
    this.cleanStageStartWanted = undefined;
    this.placeMarkerForStage();
  }

  placeMarkerForStage() {
    const s = this.stage();
    this.marker = null;
    if (!s) return;
    // Only stages with a place in the world get a beacon. "Get behind the
    // wheel", "lose the heat", "raise five stars" and "survive" are states,
    // not destinations, and a yellow marker downtown would send the player
    // across the city for nothing.
    if (s.target === 'car' || s.target === 'clean' || s.target === 'five' || s.target === 'survive') return;
    const at = s.at || [streetCoord(3), streetCoord(3)];
    const color = s.target === 'marker' ? 0xffd75e
      : s.target === 'marker2' ? 0x4da3ff
        : s.target === 'marker3' ? 0x7dffa8
          : s.target === 'ram' ? 0xff4d5e : 0xffd75e;
    const kind = s.target === 'ram' ? 'ram' : (s.target === 'marker' ? 'pickup' : 'drop');
    this.marker = { x: at[0], z: at[1], color, kind };
  }

  /** True once every job in the story is done. */
  allDone() {
    return this.save.completed.length >= MISSIONS.length;
  }

  /** Fraction of the whole story complete, 0..1. */
  get progress() { return this.save.completed.length / MISSIONS.length; }

  /**
   * The reward for the job currently on the plate, or for the last job once the
   * story is finished — the title screen's mission list reads this so a
   * completed run shows what was earned rather than an undefined entry.
   */
  rewardFor(i) {
    const m = MISSIONS[clampIndex(i, MISSIONS.length)];
    return m ? m.reward : 0;
  }

  /** Start the current job over from its first stage. */
  restartMission() {
    this.setMission(this.missionIndex);
    this.surviveTimer = 0;
    this.done = false;
  }

  /** Wipe the saved story (money, jobs, rank, respect) and start fresh. */
  resetSave() {
    this.save = MissionRunner.defaultSave();
    this.persist();
    this.setMission(0);
    this.done = false;
  }

  advance() {
    this.stageIndex += 1;
    if (this.stageIndex >= this.mission().stages.length) {
      this.completeMission();
      return 'mission-complete';
    }
    this.placeMarkerForStage();
    this.cleanStageStartWanted = undefined;
    return 'stage';
  }

  completeMission() {
    const m = this.mission();
    this.save.money += m.reward;
    this.save.respect += 300;
    if (!this.save.completed.includes(m.id)) this.save.completed.push(m.id);
    this.save.rank = Math.min(10, 1 + this.save.completed.length);
    this.done = true;
    this.persist();
  }

  nextMission() {
    if (this.missionIndex + 1 < MISSIONS.length) {
      this.setMission(this.missionIndex + 1);
      return true;
    }
    return false;
  }

  /**
   * Called every frame. ctx: {inCar, wanted, markerDist, speed, startedClean,
   * ramHits}. Returns 'stage' or 'mission-complete' on a transition.
   */
  update(dt, ctx) {
    const s = this.stage();
    if (!s || this.done) return null;
    if (s.target === 'car' && ctx.inCar) return this.advance();
    if (s.target === 'marker' && ctx.markerDist < 8) return this.advance();
    if (s.target === 'marker2' && ctx.markerDist < 8) return this.advance();
    if (s.target === 'marker3' && ctx.markerDist < 8) return this.advance();
    if (s.target === 'ram' && ctx.ramHits >= 3) return this.advance();
    // A "clean" stage only completes if the player was actually wanted while it
    // ran (startedClean), so a quiet drive does not skip it. A player who
    // arrives already at zero stars has no heat to lose, though: without the
    // cleanStageStartWanted arm below they would sit on "Lose the heat"
    // forever with nothing left to do.
    if (s.target === 'clean') {
      if (this.cleanStageStartWanted === undefined) this.cleanStageStartWanted = ctx.wanted;
      if (ctx.wanted === 0 && (ctx.startedClean || this.cleanStageStartWanted === 0)) return this.advance();
      return null;
    }
    if (s.target === 'five' && ctx.wanted >= 5) return this.advance();
    if (s.target === 'survive') {
      if (ctx.wanted >= 5) {
        this.surviveTimer += dt;
        if (this.surviveTimer >= this.surviveNeed) return this.advance();
      } else {
        // Dropping below five stars resets the clock — surviving means holding
        // the heat, not having once reached it.
        this.surviveTimer = 0;
      }
    }
    return null;
  }

  stageProgress(ctx) {
    const s = this.stage();
    if (!s) return 1;
    if (s.target === 'car') return ctx.inCar ? 1 : 0;
    if (s.target === 'survive') return Math.min(1, this.surviveTimer / this.surviveNeed);
    if (s.target === 'clean') return ctx.wanted === 0 ? 1 : 1 - ctx.wanted / 5;
    if (s.target === 'five') return ctx.wanted / 5;
    if (s.target === 'ram') return Math.min(1, ctx.ramHits / 3);
    if (s.target === 'marker' || s.target === 'marker2' || s.target === 'marker3') {
      return Math.max(0, 1 - ctx.markerDist / 240);
    }
    return this.stageIndex / this.mission().stages.length;
  }
}

function clampIndex(i, n) { return Math.max(0, Math.min(n - 1, i)); }
