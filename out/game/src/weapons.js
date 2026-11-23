// Arsenal: five switchable weapons with ammo, reload, recoil, tracers and
// impacts. Shooting is a hitscan ray from the camera (on foot) or the car
// (drive-by); the caller resolves what the ray hit.
import * as THREE from 'three';

export const WEAPONS = [
  { id: 'fists', name: 'FISTS', icon: '✊', damage: 14, rate: 0.42, mag: Infinity, reserve: Infinity, spread: 0.02, auto: false, sound: 'melee', range: 3.4 },
  { id: 'pistol', name: 'P-9 PISTOL', icon: '🔫', damage: 24, rate: 0.27, mag: 12, reserve: 96, spread: 0.016, auto: false, sound: 'pistol', range: 65 },
  { id: 'zumbador', name: 'ZUMBADOR MP', icon: '🔫', damage: 15, rate: 0.085, mag: 32, reserve: 160, spread: 0.05, auto: true, sound: 'smg', range: 55 },
  { id: 'escopeta', name: 'ESCOPETA 12', icon: '💥', damage: 18, rate: 0.8, mag: 6, reserve: 30, spread: 0.1, auto: false, sound: 'shotgun', range: 32, pellets: 6 },
  { id: 'halcon', name: 'HALCÓN RIFLE', icon: '🎯', damage: 48, rate: 0.5, mag: 20, reserve: 80, spread: 0.004, auto: false, sound: 'rifle', range: 130 },
];

export const WEAPONS_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));

/** Randomise a direction inside a cone of `spread` radians. */
export function jitterDir(dir, spread, target = new THREE.Vector3()) {
  target.copy(dir);
  target.x += (Math.random() - 0.5) * spread * 2;
  target.y += (Math.random() - 0.5) * spread * 2;
  target.z += (Math.random() - 0.5) * spread * 2;
  return target.normalize();
}

/** Damage multiplier with range: full inside 40% of the weapon's reach. */
export function rangeFalloff(weapon, dist) {
  if (dist <= weapon.range * 0.4) return 1;
  return Math.max(0.35, 1 - (dist - weapon.range * 0.4) / (weapon.range * 0.9));
}

/** Melee reach check: is `target` in front of `origin` within `range`? */
export function inMeleeArc(origin, heading, target, range, arc = 1.15) {
  const dx = target.x - origin.x, dz = target.z - origin.z;
  const d = Math.hypot(dx, dz);
  if (d > range) return false;
  let delta = Math.atan2(-dx, -dz) - heading;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta) < arc;
}

export class Arsenal {
  constructor(scene) {
    this.scene = scene;
    this.index = 1;
    this.ammo = WEAPONS.map((w) => ({ mag: w.mag, reserve: w.reserve }));
    this.cooldown = 0;
    this.reloadTimer = 0;
    this.tracers = [];
    this.muzzle = null;
    this.muzzleLife = 0;
    this.recoil = 0;
    this.owned = [true, true, true, false, false];
  }

  current() { return WEAPONS[this.index]; }
  currentAmmo() { return this.ammo[this.index]; }

  /** Kick the camera a little; the caller reads and decays this. */
  kick() { this.recoil = Math.min(1, this.recoil + 0.4); }

  select(i) {
    if (i < 0 || i >= WEAPONS.length || !this.owned[i]) return false;
    this.index = i;
    this.reloadTimer = 0;
    // A fresh weapon gets a fresh trigger: a held mouse from the last gun must
    // not silently eat the first shot.
    this._firedThisClick = false;
    return true;
  }

  /** Cycle to the next owned weapon (the mouse wheel). True on a change. */
  cycle(dir = 1) {
    for (let step = 0; step < WEAPONS.length; step++) {
      this.index = (this.index + dir + WEAPONS.length) % WEAPONS.length;
      if (this.owned[this.index]) {
        this.reloadTimer = 0;
        this._firedThisClick = false;
        return true;
      }
    }
    return false;
  }

  /** Total rounds (magazine + reserve) for a weapon id. */
  totalAmmo(id) {
    const i = WEAPONS.findIndex((w) => w.id === id);
    if (i < 0) return 0;
    const a = this.ammo[i];
    return (a.mag === Infinity ? 0 : a.mag) + (a.reserve === Infinity ? 0 : a.reserve);
  }

  /** Is the current weapon one the player can actually fire? */
  get hasLiveWeapon() {
    const w = this.current();
    const a = this.currentAmmo();
    return w.mag === Infinity || a.mag > 0 || a.reserve > 0;
  }

  /** Back to the starting loadout: a restart or a new game. */
  reset(keepOwned = false) {
    this.index = 1;
    this.ammo = WEAPONS.map((w) => ({ mag: w.mag, reserve: w.reserve }));
    this.cooldown = 0;
    this.reloadTimer = 0;
    this.recoil = 0;
    // "Continue" keeps weapons the player unlocked this session; an explicit
    // reset progress wipes them.
    if (!keepOwned) this.owned = [true, true, true, false, false];
    this._firedThisClick = false;
  }

  give(id) {
    const i = WEAPONS.findIndex((w) => w.id === id);
    if (i >= 0) { this.owned[i] = true; return true; }
    return false;
  }

  addAmmo(id, n) {
    const i = WEAPONS.findIndex((w) => w.id === id);
    if (i >= 0) this.ammo[i].reserve += n;
  }

  startReload() {
    const w = this.current();
    const a = this.currentAmmo();
    if (this.reloadTimer > 0 || a.mag === w.mag || a.reserve <= 0 || w.mag === Infinity) return false;
    this.reloadTimer = w.id === 'escopeta' ? 1.5 : 1.0;
    return true;
  }

  /**
   * Try to fire. Returns null while cooling down, reloading or empty; a
   * `{dry:true}` on an empty magazine; otherwise `{weapon, pellets}`.
   */
  tryFire(dt, isAuto) {
    this.cooldown -= dt;
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        const w = this.current();
        const a = this.currentAmmo();
        const need = w.mag - a.mag;
        const take = Math.min(need, a.reserve);
        a.mag += take;
        a.reserve -= take;
      }
      return null;
    }
    const w = this.current();
    const a = this.currentAmmo();
    if (this.cooldown > 0) return null;
    if (a.mag <= 0) {
      // Report whether a reload is actually possible: "out of ammo" and
      // "reloading" are different states and the HUD should not say R to
      // reload a weapon that has no reserve left.
      const reloadable = a.reserve > 0 && w.mag !== Infinity;
      if (reloadable) this.startReload();
      return { dry: true, reloadable };
    }
    if (!isAuto && !w.auto && this._firedThisClick) return null;
    this.cooldown = w.rate;
    if (a.mag !== Infinity) a.mag -= 1;
    this._firedThisClick = true;
    return { weapon: w, pellets: w.pellets || 1 };
  }

  /** Called when the mouse is released, so a semi-auto weapon can fire again. */
  endClick() { this._firedThisClick = false; }

  spawnTracer(from, to) {
    const mat = new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.95 });
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.09 });
    if (this.muzzle) {
      this.scene.remove(this.muzzle);
      this.muzzle.geometry?.dispose?.();
      this.muzzle.material?.dispose?.();
    }
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffd75e, transparent: true, opacity: 0.95 }));
    flash.position.copy(from);
    this.scene.add(flash);
    this.muzzle = flash;
    this.muzzleLife = 0.05;
  }

  spawnImpact(point, color = 0xcccccc) {
    const puff = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 8, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }));
    puff.position.copy(point);
    this.scene.add(puff);
    this.tracers.push({ line: puff, life: 0.26, mesh: true });
  }

  update(dt) {
    this.recoil = Math.max(0, this.recoil - dt * 3.5);
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.mesh) t.line.scale.multiplyScalar(1 + dt * 6);
      if (t.life <= 0) {
        this.scene.remove(t.line);
        t.line.geometry?.dispose?.();
        // Lines and impact sprites each own a material; leaving it behind
        // accumulates programs over a long firefight.
        t.line.material?.dispose?.();
        this.tracers.splice(i, 1);
      }
    }
    if (this.muzzle) {
      this.muzzleLife -= dt;
      if (this.muzzleLife <= 0) {
        this.scene.remove(this.muzzle);
        this.muzzle.geometry?.dispose?.();
        this.muzzle.material?.dispose?.();
        this.muzzle = null;
      }
    }
  }
}
