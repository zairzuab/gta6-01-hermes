// The player's arsenal: five switchable weapons, their ammunition bookkeeping,
// and the transient geometry a shot leaves behind (muzzle flash, tracer line,
// impact puff).
//
// Everything here is a pure gun. It owns the loadout, the trigger discipline
// (fire rate, semi-auto clicks, reload), the magazine maths and the life of its
// own meshes; it never looks at the world. The game raycasts from the camera,
// decides what the ray reached, and hands this module the two points a tracer
// should join and the point a puff should bloom at.
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Loadout
// ---------------------------------------------------------------------------
export const WEAPONS = [
  { id: 'fists',     name: 'FISTS',       icon: '✊', damage: 14, rate: 0.42,  mag: Infinity, reserve: Infinity, spread: 0.02,  auto: false, sound: 'melee',    range: 3.4 },
  { id: 'pistol',    name: 'P-9 PISTOL',  icon: '🔫', damage: 24, rate: 0.27,  mag: 12,       reserve: 96,       spread: 0.016, auto: false, sound: 'pistol',   range: 65 },
  { id: 'zumbador',  name: 'ZUMBADOR MP', icon: '🔫', damage: 15, rate: 0.085, mag: 32,       reserve: 160,      spread: 0.05,  auto: true,  sound: 'smg',      range: 55 },
  { id: 'escopeta',  name: 'ESCOPETA 12', icon: '💥', damage: 18, rate: 0.8,   mag: 6,        reserve: 30,       spread: 0.1,   auto: false, sound: 'shotgun',  range: 32, pellets: 6 },
  { id: 'halcon',    name: 'HALCÓN RIFLE', icon: '🎯', damage: 48, rate: 0.5,   mag: 20,       reserve: 80,       spread: 0.004, auto: false, sound: 'rifle',    range: 130 },
];

export const WEAPONS_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));
/** Slot 1 is the starting weapon; only these three are in the loadout at boot. */
const STARTING_OWNED = [true, true, true, false, false];
/** The shotgun loads shells one at a time, so it needs its own reload clock. */
const SLOW_RELOADS = new Set(['escopeta']);

// How long each kind of transient lives, in seconds.
const LIFE = { tracer: 0.09, impact: 0.26, muzzle: 0.05 };
// Impact puffs swell while they fade; recoil bleeds off on the same order.
const IMPACT_GROWTH = 6;
const RECOIL_DECAY = 3.5;

// ---------------------------------------------------------------------------
// Ballistics helpers (pure — no scene, no state)
// ---------------------------------------------------------------------------
/**
 * Return `dir` nudged inside a cone of `spread` radians. Spread is a half-angle
 * applied independently per axis; the result is re-normalised, so a call with
 * zero spread returns the input direction unchanged.
 */
export function jitterDir(dir, spread, target = new THREE.Vector3()) {
  target.copy(dir);
  const j = spread * 2;
  target.x += (Math.random() - 0.5) * j;
  target.y += (Math.random() - 0.5) * j;
  target.z += (Math.random() - 0.5) * j;
  return target.normalize();
}

/**
 * Damage multiplier over distance: full damage out to 40% of the weapon's
 * reach, then a linear falloff that never drops below 0.35 — beyond the
 * nominal range the caller has already refused the hit, so this floor only
 * softens the last stretch.
 */
export function rangeFalloff(weapon, dist) {
  const full = weapon.range * 0.4;
  if (dist <= full) return 1;
  return Math.max(0.35, 1 - (dist - full) / (weapon.range * 0.9));
}

/**
 * Melee test: is `target` within `range` of `origin`, and inside `arc` radians
 * either side of `heading`? `heading` uses the game's convention (atan2 of the
 * facing vector), so the heading to a point is atan2(-dx, -dz).
 */
export function inMeleeArc(origin, heading, target, range, arc = 1.15) {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  if (Math.hypot(dx, dz) > range) return false;
  let delta = Math.atan2(-dx, -dz) - heading;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta) < arc;
}

// ---------------------------------------------------------------------------
// Transient effects
// ---------------------------------------------------------------------------
/**
 * Tracers and puffs live briefly and are built from scratch, so the geometry
 * and material are released with them. Nothing here is cached or shared:
 * disposing the pair cannot affect any other effect.
 */
function release(mesh) {
  mesh.geometry?.dispose?.();
  mesh.material?.dispose?.();
}

class Effects {
  constructor(scene) {
    this.scene = scene;
    /** @type {{mesh: THREE.Object3D, life: number, grow?: boolean}[]} */
    this.live = [];
    this.flash = null;
    this.flashLife = 0;
  }

  _add(mesh, life, grow = false) {
    this.scene.add(mesh);
    this.live.push({ mesh, life, grow });
  }

  /** A tracer from muzzle to hit point, replacing the one flash that was up. */
  tracer(from, to) {
    const mat = new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.95 });
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    this._add(new THREE.Line(geo, mat), LIFE.tracer);
    this.muzzle(from);
  }

  /** A small round flash sitting on the shooter's muzzle. */
  muzzle(at) {
    if (this.flash) {
      this.scene.remove(this.flash);
      release(this.flash);
    }
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffd75e, transparent: true, opacity: 0.95 }));
    flash.position.copy(at);
    this.scene.add(flash);
    this.flash = flash;
    this.flashLife = LIFE.muzzle;
  }

  /** An impact puff at the point the ray stopped. */
  impact(point, color = 0xcccccc) {
    const puff = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 8, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }));
    puff.position.copy(point);
    this._add(puff, LIFE.impact, true);
  }

  /** Age everything down; sweep out whatever expired this step. */
  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i];
      e.life -= dt;
      if (e.grow) e.mesh.scale.multiplyScalar(1 + dt * IMPACT_GROWTH);
      if (e.life <= 0) {
        this.scene.remove(e.mesh);
        release(e.mesh);
        this.live.splice(i, 1);
      }
    }
    if (!this.flash) return;
    this.flashLife -= dt;
    if (this.flashLife <= 0) {
      this.scene.remove(this.flash);
      release(this.flash);
      this.flash = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Arsenal
// ---------------------------------------------------------------------------
export class Arsenal {
  constructor(scene) {
    this.scene = scene;
    this.index = 1;
    this.owned = [...STARTING_OWNED];
    this.ammo = Arsenal.freshAmmo();

    this.cooldown = 0;
    this.reloadTimer = 0;
    this.recoil = 0;
    this.effects = new Effects(scene);
    this._firedThisClick = false;
  }

  /** One magazine/reserve pair per slot, straight from the loadout table. */
  static freshAmmo() {
    return WEAPONS.map((w) => ({ mag: w.mag, reserve: w.reserve }));
  }

  // ---- reading state -------------------------------------------------------
  current() { return WEAPONS[this.index]; }
  currentAmmo() { return this.ammo[this.index]; }

  /** Index of a weapon id, or -1 when the id is not in the loadout. */
  static slotOf(id) { return WEAPONS.findIndex((w) => w.id === id); }

  /** Total rounds held by one weapon: 0 for an infinite magazine. */
  totalAmmo(id) {
    const i = Arsenal.slotOf(id);
    if (i < 0) return 0;
    const a = this.ammo[i];
    const mag = a.mag === Infinity ? 0 : a.mag;
    const reserve = a.reserve === Infinity ? 0 : a.reserve;
    return mag + reserve;
  }

  /**
   * True when the current weapon can still do something: an infinite magazine
   * always can, otherwise there must be a round in the chamber or in reserve.
   */
  get hasLiveWeapon() {
    const a = this.currentAmmo();
    return this.current().mag === Infinity || a.mag > 0 || a.reserve > 0;
  }

  // ---- switching -----------------------------------------------------------
  /** Select a slot. Refuses a locked or out-of-range slot; returns success. */
  select(i) {
    if (i < 0 || i >= WEAPONS.length || !this.owned[i]) return false;
    this.index = i;
    this._clearTrigger();
    return true;
  }

  /** Step to the next (or previous) owned slot, wrapping around. */
  cycle(dir = 1) {
    for (let n = 0; n < WEAPONS.length; n++) {
      this.index = (this.index + dir + WEAPONS.length) % WEAPONS.length;
      if (this.owned[this.index]) {
        this._clearTrigger();
        return true;
      }
    }
    return false;
  }

  /** A new weapon gets a clean reload and a clean trigger. */
  _clearTrigger() {
    this.reloadTimer = 0;
    // A click held from the previous gun must not be swallowed, and must not
    // fire the new one: forget it entirely on a switch.
    this._firedThisClick = false;
  }

  // ---- loadout changes -----------------------------------------------------
  /** Unlock a weapon (a pickup). True when the id was known. */
  give(id) {
    const i = Arsenal.slotOf(id);
    if (i < 0) return false;
    this.owned[i] = true;
    return true;
  }

  /** Add rounds to a weapon's reserve. Unknown ids are ignored. */
  addAmmo(id, n) {
    const i = Arsenal.slotOf(id);
    if (i >= 0) this.ammo[i].reserve += n;
  }

  /** Back to the starting loadout; `keepOwned` carries unlocks into a new run. */
  reset(keepOwned = false) {
    this.index = 1;
    this.ammo = Arsenal.freshAmmo();
    this.cooldown = 0;
    this.recoil = 0;
    if (!keepOwned) this.owned = [...STARTING_OWNED];
    this._clearTrigger();
  }

  // ---- shooting ------------------------------------------------------------
  /** Begin a reload. False if one is running, the gun is full, or nothing to load. */
  startReload() {
    const w = this.current();
    const a = this.currentAmmo();
    const busy = this.reloadTimer > 0;
    if (busy || w.mag === Infinity || a.mag === w.mag || a.reserve <= 0) return false;
    this.reloadTimer = SLOW_RELOADS.has(w.id) ? 1.5 : 1.0;
    return true;
  }

  /** Move however many rounds the magazine needs out of the reserve. */
  _completeReload() {
    const a = this.currentAmmo();
    const take = Math.min(this.current().mag - a.mag, a.reserve);
    a.mag += take;
    a.reserve -= take;
  }

  /**
   * Advance timers and attempt a shot.
   *
   * Returns null when nothing happened (cooling down, reloading, or a
   * semi-auto gun whose click was already spent), `{dry, reloadable}` when the
   * magazine is empty, and `{weapon, pellets}` when a round went off. The
   * caller resolves where the ray lands.
   */
  tryFire(dt, isAuto) {
    this.cooldown -= dt;

    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this._completeReload();
      return null;
    }

    if (this.cooldown > 0) return null;

    const w = this.current();
    const a = this.currentAmmo();
    if (a.mag <= 0) {
      // "Out of ammo" and "can reload" are different states; report which this
      // is so the HUD does not offer a reload that cannot happen.
      const reloadable = w.mag !== Infinity && a.reserve > 0;
      if (reloadable) this.startReload();
      return { dry: true, reloadable };
    }

    if (!w.auto && !isAuto && this._firedThisClick) return null;

    this.cooldown = w.rate;
    if (a.mag !== Infinity) a.mag -= 1;
    this._firedThisClick = true;
    return { weapon: w, pellets: w.pellets || 1 };
  }

  /** Arm the trigger again for a semi-auto weapon (the mouse came up). */
  endClick() { this._firedThisClick = false; }

  /** Kick the camera; the caller reads `recoil` and decays the view with it. */
  kick() { this.recoil = Math.min(1, this.recoil + 0.4); }

  // ---- per-frame -----------------------------------------------------------
  update(dt) {
    this.recoil = Math.max(0, this.recoil - dt * RECOIL_DECAY);
    this.effects.update(dt);
  }

  // ---- transient geometry --------------------------------------------------
  spawnTracer(from, to) { this.effects.tracer(from, to); }
  spawnImpact(point, color = 0xcccccc) { this.effects.impact(point, color); }
}
