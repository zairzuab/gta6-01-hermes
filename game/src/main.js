// Boot and the one loop.
//
// The world is built from the city, the traffic, the police, the player and
// the mission runner; this file owns the renderer, the third-person camera,
// the input routing, the combat resolution, the pickups, the HUD and the
// title / pause / phone / end screens. Simulation runs in fixed 1/60 s steps
// (several in a slow frame, none in a fast one) and the renderer paints after.
//
// ?shot=start|play|chase|boardwalk|docks stages a scene for a screenshot and
// sets window.__shotReady; ?time=HH:MM and ?seed=N pin the clock and the RNG.
// ?time= is honoured on the title screen too, so a staged shot can pin the hour
// before the first frame (the HUD clock is only written while playing).
import * as THREE from 'three';
import { City, COAST_Z } from './city.js';
import { Player } from './player.js';
import { Traffic } from './traffic.js';
import { Police } from './police.js';
import { Hud } from './hud.js';
import { Arsenal, jitterDir, rangeFalloff, inMeleeArc } from './weapons.js';
import { SoundBank } from './audio.js';
import { Input } from './input.js';
import { MissionRunner, MISSIONS } from './missions.js';
import { makePickup } from './vehicles.js';
import { clamp, damp, angleDelta, formatMoney, formatClock, mulberry32 } from './util.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const bootEl = $('boot');
let bootHidden = false;
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isInteger(seedParam) ? seedParam : 20261123;
const rnd = mulberry32(seed);

// ---- renderer --------------------------------------------------------------
const canvas = $('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  // No WebGL: say so on the boot overlay instead of failing silently.
  const bootErr = $('bootErr');
  if (bootErr) bootErr.textContent = 'WebGL could not start: ' + (err?.message || err);
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.14;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 4200);
camera.position.set(60, 26, 170);

// A soft camera-following fill so the player and their car always read, even
// on the shadowed side of the street at night.
const fill = new THREE.DirectionalLight(0xe8f0ff, 0.5);
scene.add(fill);
scene.add(fill.target);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- the world -------------------------------------------------------------
const city = new City(scene);
const traffic = new Traffic(scene, city);
const player = new Player(scene, city);
const police = new Police(scene, city);
const arsenal = new Arsenal(scene);
const hud = new Hud();
const sound = new SoundBank();
const input = new Input(canvas);
const missions = new MissionRunner();

// Traffic and the hero car are built after the City's own scan, so their
// headlight beams have to be registered before the first night pass.
city.collectHeadlights();

// ---- day / night -----------------------------------------------------------
const env = { day: 1, dusk: 0, sunDir: new THREE.Vector3(0, 1, 0), focus: new THREE.Vector3() };
const _sun = new THREE.Vector3();
const timeParam = params.get('time');
let clockMin = timeParam && /^\d{1,2}:\d{2}$/.test(timeParam)
  ? (Number(timeParam.slice(0, 2)) * 60 + Number(timeParam.slice(3, 5)))
  : 18 * 60 + 45;
let timeScale = 1.6;           // game minutes per real second
// The title screen does not run updateHud(), so the clock is painted once here
// (and again by updateHud as soon as play starts).
const paintClock = () => { $('clock').textContent = formatClock(clockMin); };
paintClock();
/** The menu keeps a clock of its own, pinned by ?time= before the game starts. */
const paintTitleClock = () => { const el = $('titleClock'); if (el) el.textContent = formatClock(clockMin); };
paintTitleClock();

/** Sun elevation, daylight factor and dusk factor for a clock time. */
function sunEnv(minutes) {
  const dayT = (minutes - 360) / 780;          // 06:00 -> 0, 19:00 -> 1
  const alt = Math.sin(dayT * Math.PI);        // -1 .. 1
  const az = Math.PI * (0.2 + 0.6 * dayT);
  const up = Math.max(0.05, alt) * 1.15;
  _sun.set(Math.cos(az), up, Math.sin(az) * 0.62).normalize();
  if (alt <= 0.02) _sun.set(-0.38, 0.5, -0.5).normalize();   // the moon
  return {
    day: clamp(alt * 1.7 + 0.1, 0, 1),
    dusk: clamp(1 - Math.abs(alt) * 3.0, 0, 1),
    sunDir: _sun,
  };
}

// ---- game state ------------------------------------------------------------
let state = 'title';           // title | play | pause | phone | end
let stateBeforePhone = 'play';
let simTime = 0;
let idleTime = 0;
let fps = 0;
let fpsAccum = 0;
let fpsFrames = 0;
let muted = false;
let cleanArmed = false;
let ramHits = 0;
let nextMissionTimer = 0;
let storyTimer = 0;
let shotFrames = 0;
let wreckWarned = false;
let freeCam = null;
// The orbit the title and end screens use; a staged screenshot overrides it
// with its own `cam`, and normal play passes null so the chase cam drives.
const MENU_CAM = { dist: 30, pitch: 0.3, spin: 0.1 };
const mctx = {
  inCar: false, wanted: 0, markerDist: Infinity, speed: 0, startedClean: false, ramHits: 0,
  shotsFired: 0, pedDowns: 0, wantedPeak: 0,
};
/** A run-statistics snapshot for the pause / end screens. */
function runStats() {
  return {
    shots: mctx.shotsFired,
    peds: mctx.pedDowns,
    peak: mctx.wantedPeak,
    jobs: missions.save.completed.length,
    money: missions.save.money,
  };
}

// ---- camera ----------------------------------------------------------------
const camRig = {
  mode: 0, yaw: Math.PI, pitch: 0.34, shake: 0,
  pos: new THREE.Vector3(70, 30, 180),
  look: new THREE.Vector3(30, 2, 96),
  toggle() {
    this.mode = (this.mode + 1) % 3;
    hud.toast(['CHASE CAM', 'HOOD CAM', 'AERIAL CAM'][this.mode]);
  },
  update(dt, free) {
    const p = player;
    const desired = new THREE.Vector3();
    const lookAt = new THREE.Vector3();
    if (free) {
      this.yaw += dt * free.spin;
      const cp = Math.cos(free.pitch);
      desired.set(
        p.x + Math.sin(this.yaw) * cp * free.dist,
        p.groundY + 1.9 + Math.sin(free.pitch) * free.dist,
        p.z + Math.cos(this.yaw) * cp * free.dist);
      lookAt.set(p.x, p.groundY + (free.look ?? 2.4), p.z);
      this.pos.lerp(desired, 1 - Math.exp(-2.6 * dt));
      this.look.lerp(lookAt, 1 - Math.exp(-3.4 * dt));
    } else if (p.inCar) {
      const behind = p.heading + p.camOrbit;
      const dist = this.mode === 1 ? 0.2 : this.mode === 2 ? 24 : 8.6;
      const pitch = this.mode === 1 ? 0.1 : this.mode === 2 ? 0.95 : 0.3;
      this.yaw += angleDelta(this.yaw, behind) * Math.min(1, dt * 5);
      const cp = Math.cos(pitch);
      let d = dist;
      for (let i = 0; i < 6; i++) {
        const tx = p.x + Math.sin(this.yaw) * cp * d;
        const tz = p.z + Math.cos(this.yaw) * cp * d;
        const ty = p.groundY + 1.7 + Math.sin(pitch) * d;
        if (!city.hitsBuilding(tx, tz, 0.6) && !city.isWater(tx, tz)) break;
        d *= 0.7;
      }
      desired.set(
        p.x + Math.sin(this.yaw) * cp * d,
        Math.max(0.5, p.groundY + 1.7 + Math.sin(pitch) * d),
        p.z + Math.cos(this.yaw) * cp * d);
      lookAt.set(p.x - Math.sin(this.yaw) * 5, p.groundY + 1.5, p.z - Math.cos(this.yaw) * 5);
      const k = this.mode === 1 ? 1 : 1 - Math.exp(-9 * dt);
      this.pos.lerp(desired, k);
      this.look.lerp(lookAt, 1 - Math.exp(-12 * dt));
    } else {
      this.yaw = p.camYaw;
      const pitch = p.camPitch;
      const dist = this.mode === 2 ? 22 : 5.6;
      const cp = Math.cos(pitch);
      let d = dist;
      for (let i = 0; i < 6; i++) {
        const tx = p.x + Math.sin(this.yaw) * cp * d;
        const tz = p.z + Math.cos(this.yaw) * cp * d;
        const ty = p.groundY + 1.7 + Math.sin(pitch) * d;
        if (!city.hitsBuilding(tx, tz, 0.5) && !city.isWater(tx, tz) && ty > 0.4) break;
        d *= 0.7;
      }
      desired.set(
        p.x + Math.sin(this.yaw) * cp * d,
        Math.max(0.45, p.groundY + 1.7 + Math.sin(pitch) * d),
        p.z + Math.cos(this.yaw) * cp * d);
      lookAt.set(p.x - Math.sin(this.yaw) * 4.5, p.groundY + 1.55, p.z - Math.cos(this.yaw) * 4.5);
      this.pos.lerp(desired, 1 - Math.exp(-15 * dt));
      this.look.lerp(lookAt, 1 - Math.exp(-17 * dt));
    }

    this.shake = Math.max(0, this.shake - dt * 2.4);
    const s = this.shake * this.shake * 0.6 + p.crashShake * 0.22;
    camera.position.set(
      this.pos.x + (Math.random() - 0.5) * s,
      this.pos.y + (Math.random() - 0.5) * s,
      this.pos.z + (Math.random() - 0.5) * s);
    camera.lookAt(this.look);
    const targetFov = 62 + (p.inCar ? Math.min(14, Math.abs(p.speed) * 0.3) : 0);
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 4);
      camera.updateProjectionMatrix();
    }
  },
};

// ---- mission marker --------------------------------------------------------
const markerBeam = new THREE.Mesh(
  new THREE.CylinderGeometry(1.5, 1.5, 34, 18, 1, true),
  new THREE.MeshBasicMaterial({
    color: 0xffd75e, transparent: true, opacity: 0.16, fog: false,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
markerBeam.visible = false;
scene.add(markerBeam);
const markerRing = new THREE.Mesh(
  new THREE.TorusGeometry(3.6, 0.18, 8, 32),
  new THREE.MeshBasicMaterial({ color: 0xffd75e, fog: false }));
markerRing.rotation.x = Math.PI / 2;
markerRing.visible = false;
scene.add(markerRing);

function updateMarker(dt) {
  const st = missions.stage();
  let m = missions.marker;
  if (st && st.target === 'ram' && traffic.rival) m = { x: traffic.rival.x, z: traffic.rival.z, color: 0xff4d5e, kind: 'ram' };
  if (!m) { markerBeam.visible = false; markerRing.visible = false; return; }
  const gy = city.groundHeightAt(m.x, m.z);
  markerBeam.visible = true;
  markerRing.visible = true;
  markerBeam.position.set(m.x, gy + 17, m.z);
  markerRing.position.set(m.x, gy + 0.25, m.z);
  markerRing.rotation.z += dt * 0.8;
  const pulse = 1 + Math.sin(simTime * 4) * 0.12;
  markerRing.scale.setScalar(pulse);
  markerBeam.material.color.setHex(m.color);
  markerRing.material.color.setHex(m.color);
}

// ---- pickups ---------------------------------------------------------------
const pickups = [];
function addPickup(kind, x, z, weaponId = null) {
  const mesh = makePickup(kind);
  mesh.position.set(x, city.groundHeightAt(x, z), z);
  scene.add(mesh);
  pickups.push({ kind, weaponId, x, z, mesh, taken: false, phase: rnd() * 6 });
}
function buildPickups() {
  addPickup('health', 90, -74);
  addPickup('health', 96, 34);
  addPickup('health', 56, COAST_Z + 90);
  addPickup('armour', -30, -132);
  addPickup('armour', -280, -46);
  addPickup('cash', 30, -120);
  addPickup('cash', -150, 132);
  addPickup('cash', -272, -18);
  addPickup('cash', 60, 84);
  addPickup('weapon', 66, 70, 'escopeta');
  addPickup('weapon', -84, 96, 'halcon');
}
buildPickups();

function updatePickups(dt) {
  for (const p of pickups) {
    if (p.taken) continue;
    p.mesh.rotation.y += dt * 1.3;
    p.mesh.position.y = city.groundHeightAt(p.x, p.z) + 0.12 + Math.sin(simTime * 2 + p.phase) * 0.12;
    if (Math.hypot(p.x - player.x, p.z - player.z) < 3.0) collect(p);
  }
}

function collect(p) {
  p.taken = true;
  scene.remove(p.mesh);
  if (p.kind === 'health') { player.heal(45); sound.pickup(); hud.toast('+45 HEALTH'); }
  else if (p.kind === 'armour') { player.addArmour(60); sound.pickup(); hud.toast('+60 ARMOUR'); }
  else if (p.kind === 'cash') {
    missions.save.money += 1500;
    sound.cash();
    hud.toast('+$1,500');
  } else if (p.kind === 'weapon') {
    arsenal.give(p.weaponId);
    arsenal.addAmmo(p.weaponId, 48);
    sound.mission();
    hud.toast('WEAPON UNLOCKED');
  }
  missions.persist();
}

// ---- smoke -----------------------------------------------------------------
const smokes = [];
const smokeGeo = new THREE.SphereGeometry(0.5, 8, 6);
function puff(x, y, z, dark) {
  const mat = new THREE.MeshBasicMaterial({ color: dark ? 0x222222 : 0x9aa0a6, transparent: true, opacity: 0.4, depthWrite: false });
  const m = new THREE.Mesh(smokeGeo, mat);
  m.position.set(x, y, z);
  m.scale.setScalar(0.5);
  scene.add(m);
  smokes.push({ m, life: 1.4, dark });
}
function updateSmoke(dt) {
  // The player's car smokes when its engine is hurt; dead cars smoke harder.
  if (player.inCar && player.enginePct < 58 && Math.random() < dt * (player.enginePct < 34 ? 22 : 8)) {
    const back = player.heading + Math.PI;
    puff(player.x - Math.sin(back) * 1.8, player.groundY + 0.8, player.z - Math.cos(back) * 1.8, player.enginePct < 34);
  }
  for (const c of traffic.cars) {
    if (c.dead && Math.random() < dt * 6) puff(c.x, 1.2, c.z, true);
  }
  if (traffic.rival && traffic.rival.stopped && Math.random() < dt * 8) {
    puff(traffic.rival.x, 1.2, traffic.rival.z, true);
  }
  for (let i = smokes.length - 1; i >= 0; i--) {
    const s = smokes[i];
    s.life -= dt;
    s.m.position.y += dt * 1.6;
    s.m.scale.multiplyScalar(1 + dt * 1.4);
    s.m.material.opacity = Math.max(0, s.life / 1.4) * 0.4;
    if (s.life <= 0) {
      scene.remove(s.m);
      s.m.material.dispose();
      smokes.splice(i, 1);
    }
  }
}

// ---- combat ----------------------------------------------------------------
const _dir = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _end = new THREE.Vector3();

function raySphere(o, d, cx, cy, cz, r) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : Infinity;
}

/** Slab test against every building footprint; nearest hit distance or maxT. */
function rayBuildings(o, d, maxT) {
  let best = maxT;
  for (const c of city.colliders) {
    const h = c.h || 30;
    const t = rayBox(o, d, c.x - c.halfX, 0, c.z - c.halfZ, c.x + c.halfX, h, c.z + c.halfZ, best);
    if (t < best) best = t;
  }
  return best;
}

function rayBox(o, d, minx, miny, minz, maxx, maxy, maxz, maxT) {
  let tmin = 0, tmax = maxT;
  const axes = [
    [o.x, d.x, minx, maxx],
    [o.y, d.y, miny, maxy],
    [o.z, d.z, minz, maxz],
  ];
  for (const [oo, dd, mn, mx] of axes) {
    if (Math.abs(dd) < 1e-8) {
      if (oo < mn || oo > mx) return Infinity;
      continue;
    }
    let t1 = (mn - oo) / dd, t2 = (mx - oo) / dd;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

function fireWeapon(dt) {
  const w = arsenal.current();
  // Only an automatic weapon keeps firing while the trigger is held; a pistol,
  // shotgun or rifle needs a fresh click, which is what `tryFire`'s
  // `_firedThisClick` guard is for. Passing `mouseDown` outright made every
  // weapon fully automatic and the guard dead code.
  const res = arsenal.tryFire(dt, input.mouseDown && w.auto);
  if (!res) return;
  if (res.dry) {
    sound.click();
    hud.toast(res.reloadable ? 'RELOADING…' : 'NO AMMO');
    if (res.reloadable) arsenal.startReload();
    return;
  }
  arsenal.kick();
  sound.gunshot(w.sound);
  mctx.shotsFired += 1;
  camera.getWorldDirection(_dir);
  _muzzle.set(player.x, player.groundY + 1.5, player.z).addScaledVector(_dir, 0.8);
  for (let i = 0; i < res.pellets; i++) {
    const d = jitterDir(_dir, w.spread, new THREE.Vector3());
    resolveShot(w, camera.position, d);
  }
  traffic.panicNear(player.x, player.z, 34);
  // Gunfire is a crime only when someone is close enough to hear it.
  const witnessed = police.nearestPoliceDist(player.x, player.z) < 70
    || traffic.peds.some((p) => !p.dead && Math.hypot(p.x - player.x, p.z - player.z) < 70);
  if (witnessed) crime(w.id === 'fists' ? 0 : 3, 'discharge');
}

function resolveShot(w, o, d) {
  let bestT = rayBuildings(o, d, w.range);
  let kind = 'world', obj = null;
  for (const p of traffic.peds) {
    if (p.dead) continue;
    const t = raySphere(o, d, p.x, 1.0, p.z, 0.8);
    if (t < bestT) { bestT = t; kind = 'ped'; obj = p; }
  }
  for (const c of traffic.cars) {
    if (c.dead) continue;
    const t = raySphere(o, d, c.x, 1.0, c.z, 2.3);
    if (t < bestT) { bestT = t; kind = 'car'; obj = c; }
  }
  for (const c of police.cruisers) {
    if (c.disabled) continue;
    const t = raySphere(o, d, c.x, 1.0, c.z, 2.4);
    if (t < bestT) { bestT = t; kind = 'police'; obj = c; }
  }
  if (traffic.rival && !traffic.rival.stopped) {
    const t = raySphere(o, d, traffic.rival.x, 1.0, traffic.rival.z, 2.4);
    if (t < bestT) { bestT = t; kind = 'rival'; obj = traffic.rival; }
  }

  _end.copy(o).addScaledVector(d, Math.min(bestT, w.range));
  arsenal.spawnTracer(_muzzle, _end);
  const falloff = rangeFalloff(w, bestT);

  if (kind === 'ped') {
    const died = traffic.hitPed(obj, w.damage * falloff);
    crime(died ? 18 : 6, 'shoot');
    traffic.panicNear(obj.x, obj.z, 30);
    if (died) hud.toast('CIVILIAN DOWN');
    mctx.pedDowns += died ? 1 : 0;
  } else if (kind === 'car') {
    const died = traffic.damageCar(obj, w.damage * falloff);
    crime(died ? 12 : 5, 'car');
    traffic.panicNear(obj.x, obj.z, 26);
    if (died) hud.toast('CAR DISABLED');
  } else if (kind === 'police') {
    const died = police.damageCruiser(obj, w.damage * falloff);
    crime(died ? 30 : 10, 'police');
    if (died) hud.toast('CRUISER DOWN');
  } else if (kind === 'rival') {
    obj.hp -= 1;
    crime(4, 'rival');
    if (obj.hp <= 0 && !obj.stopped) {
      obj.stopped = true;
      hud.center('RUNNER DOWN', 'The courier is done. Lose the heat.', 'gold', 2.6);
    }
  } else {
    arsenal.spawnImpact(_end, 0xd8c9a8);
  }
}

function melee() {
  if (player.meleeCooldown > 0) return;
  player.meleeCooldown = 0.42;
  player.meleeSwing = 1;
  sound.gunshot('melee');
  let best = null, bestD = 3.4, bestKind = null;
  for (const p of traffic.peds) {
    if (p.dead) continue;
    if (inMeleeArc(player, player.heading, p, 3.4) && Math.hypot(p.x - player.x, p.z - player.z) < bestD) {
      best = p; bestD = Math.hypot(p.x - player.x, p.z - player.z); bestKind = 'ped';
    }
  }
  for (const c of traffic.cars) {
    if (c.dead) continue;
    if (inMeleeArc(player, player.heading, c, 3.6) && Math.hypot(c.x - player.x, c.z - player.z) < bestD) {
      best = c; bestD = Math.hypot(c.x - player.x, c.z - player.z); bestKind = 'car';
    }
  }
  for (const c of police.cruisers) {
    if (c.disabled) continue;
    if (inMeleeArc(player, player.heading, c, 3.6) && Math.hypot(c.x - player.x, c.z - player.z) < bestD) {
      best = c; bestD = Math.hypot(c.x - player.x, c.z - player.z); bestKind = 'police';
    }
  }
  if (!best) return;
  if (bestKind === 'ped') {
    const died = traffic.hitPed(best, 34);
    crime(died ? 16 : 8, 'melee');
    if (died) hud.toast('CIVILIAN DOWN');
  } else if (bestKind === 'car') {
    const died = traffic.damageCar(best, 26);
    crime(died ? 12 : 6, 'car');
    best.scared = 3;
  } else {
    const died = police.damageCruiser(best, 26);
    crime(died ? 30 : 12, 'police');
  }
  sound.thud(1);
  camRig.shake = Math.max(camRig.shake, 0.25);
}

// ---- crimes and wanted -----------------------------------------------------
function crime(amount, reason) {
  if (amount <= 0) return;
  const before = police.wanted;
  const r = police.crime(amount, reason, player.x, player.z);
  if (r.raised && r.to > before) {
    missions.save.bestWanted = Math.max(missions.save.bestWanted, r.to);
    mctx.wantedPeak = Math.max(mctx.wantedPeak, r.to);
    hud.center('WANTED ' + '★'.repeat(r.to), wantedLine(r.to), 'gold', 2.4);
    sound.radioBlip();
    if (r.to >= 3) hud.ticker('PORT AZUL PD', 'P', 'All units: suspect is armed and dangerous. Use of force authorised.');
    if (r.to >= 5) hud.ticker('PORT AZUL PD', 'P', 'Armoured response rolling. Air support overhead.');
    missions.persist();
  }
}

function wantedLine(to) {
  return to === 1 ? 'A patrol noticed. Keep moving.'
    : to === 2 ? 'Cruisers inbound. A roadblock is being set.'
      : to === 3 ? 'Air support is overhead.'
        : to === 4 ? 'The city is locked down.'
          : 'Maximum response. Survive.';
}

// ---- interactions ----------------------------------------------------------
function nearestRide() {
  let best = null, bestD = 5.2;
  if (player.car) {
    const d = Math.hypot(player.car.position.x - player.x, player.car.position.z - player.z);
    if (d < bestD) { bestD = d; best = { mesh: player.car, hero: true }; }
  }
  const t = traffic.nearestCar(player.x, player.z, bestD);
  if (t) best = t;
  return best;
}

function onEnterExit() {
  if (player.inCar) { player.exitCar(); sound.click(); return; }
  const ride = nearestRide();
  if (!ride) { sound.denied(); return; }
  if (ride.hero) {
    player.enterCar(ride.mesh);
    sound.engineStart();
  } else {
    player.enterCar(traffic.steal(ride));
    crime(ride.parked ? 5 : 9, 'steal');
    hud.toast(ride.parked ? 'STOLEN: ' + (ride.mesh.userData.name || 'RIDE') : 'CAR-JACKED');
    traffic.panicNear(player.x, player.z, 34);
    sound.engineStart();
  }
  city.addHeadlights(player.car);
}

function onSteal() {
  if (player.inCar) return;
  const ride = nearestRide();
  if (!ride || ride.hero) { sound.denied(); return; }
  player.enterCar(traffic.steal(ride));
  city.addHeadlights(player.car);
  crime(9, 'steal');
  hud.toast('STOLEN: ' + (ride.mesh.userData.name || 'RIDE'));
  traffic.panicNear(player.x, player.z, 36);
  sound.engineStart();
}

function promptText() {
  if (state !== 'play') return '';
  if (player.inCar) return 'E — EXIT · H — HORN · C — CAMERA';
  const ride = nearestRide();
  if (!ride) return '';
  return ride.hero ? 'E — DRIVE' : (ride.parked ? 'E — ENTER · F — STEAL' : 'F — CAR-JACK');
}

// ---- missions --------------------------------------------------------------
function missionGiver() {
  const id = missions.mission().id;
  return id === 'delivery' || id === 'port' ? 'LOURDES' : 'ROXY';
}
function missionAvatar() { return missionGiver() === 'LOURDES' ? 'L' : 'R'; }

function updateMissions(dt) {
  const st = missions.stage();
  if (st && st.target === 'ram' && !traffic.rival) {
    traffic.spawnRival(missions.marker.x, missions.marker.z);
    hud.ticker('ROXY', 'R', 'Their courier is moving. Ram the car three times.');
  }
  if ((!st || st.target !== 'ram') && traffic.rival) traffic.clearRival();

  if (traffic.rival && !traffic.rival.stopped) {
    const d = Math.hypot(traffic.rival.x - player.x, traffic.rival.z - player.z);
    if (d < 3.9 && Math.abs(player.speed) > 7) {
      ramHits++;
      traffic.rival.hp--;
      traffic.rival.speed *= 0.4;
      player.speed *= 0.82;
      crime(6, 'ram');
      sound.crash(true);
      camRig.shake = Math.max(camRig.shake, 0.6);
      if (traffic.rival.hp <= 0) {
        traffic.rival.stopped = true;
        hud.center('RUNNER DOWN', 'The courier is done. Lose the heat.', 'gold', 2.6);
      } else {
        hud.toast(`RAM HIT ${ramHits} / 3`);
      }
    }
  }

  if (st && st.target === 'clean' && police.wanted > 0) cleanArmed = true;

  mctx.inCar = player.inCar;
  mctx.wanted = police.wanted;
  mctx.speed = Math.abs(player.speed);
  mctx.startedClean = cleanArmed;
  mctx.ramHits = ramHits;
  const m = missions.marker;
  mctx.markerDist = m ? Math.hypot(player.x - m.x, player.z - m.z) : Infinity;

  const res = missions.update(dt, mctx);
  if (res === 'stage') onStage();
  else if (res === 'mission-complete') onMissionComplete();

  if (nextMissionTimer > 0) {
    nextMissionTimer -= dt;
    if (nextMissionTimer <= 0) {
      if (missions.nextMission()) {
        cleanArmed = false; ramHits = 0;
        hud.center(missions.mission().name, missions.mission().brief, '', 3.0);
      }
    }
  }
  if (storyTimer > 0) {
    storyTimer -= dt;
    if (storyTimer <= 0) {
      hud.center('KINGPIN', 'Every job done. Port Azul is yours.', 'gold', 5);
      sound.levelUp();
      storyTimer = 0;
    }
  }
}

function onStage() {
  const st = missions.stage();
  sound.mission();
  hud.center(st.name, st.obj, '', 2.4);
  if (st.target === 'clean') cleanArmed = false;
  if (st.target === 'ram') { ramHits = 0; hud.ticker('ROXY', 'R', 'Ram their car three times. Do not let them get away.'); }
  else if (st.target === 'five') hud.ticker('LOURDES', 'L', 'Five stars? You are either a legend or a fool, Marlow.');
  else hud.ticker(missionGiver(), missionAvatar(), st.obj);
}

function onMissionComplete() {
  const m = missions.mission();
  sound.mission();
  missions.persist();
  hud.center('JOB COMPLETE', `${m.name} — $${m.reward.toLocaleString('en-US')} paid`, 'gold', 3.4);
  hud.toast(`${missions.save.completed.length}/${MISSIONS.length} JOBS · ${formatMoney(missions.save.money)}`);
  if (missions.allDone()) storyTimer = 3.6;
  else nextMissionTimer = 3.0;
}

// ---- spikes, roadblocks, tank ----------------------------------------------
function checkHazards() {
  if (police.checkSpikes(player.x, player.z) && player.inCar) {
    player.tiresPopped = true;
    player.speed *= 0.5;
    sound.spike();
    hud.toast('TYRES SHREDDED');
    camRig.shake = Math.max(camRig.shake, 0.5);
  }
  if (police.tankContact(player.x, player.z)) {
    const dead = player.damage(12, 'armour');
    player.speed *= 0.7;
    camRig.shake = Math.max(camRig.shake, 0.5);
    hud.damageFlash(0.5);
    if (dead) endGame('wasted');
  }
  // Run-down pedestrians.
  if (player.inCar && Math.abs(player.speed) > 4) {
    for (const p of traffic.peds) {
      if (p.dead) continue;
      if (Math.hypot(p.x - player.x, p.z - player.z) < 2.4) {
        const died = traffic.hitPed(p, 60);
        crime(died ? 16 : 8, 'runover');
        sound.thud(1);
        camRig.shake = Math.max(camRig.shake, 0.3);
        traffic.panicNear(p.x, p.z, 30);
        if (died) hud.toast('CIVILIAN DOWN');
      }
    }
  }
}

// ---- screens ---------------------------------------------------------------
function showScreen(name) {
  for (const id of ['startScreen', 'pauseScreen', 'endScreen', 'phoneScreen']) {
    $(id).classList.toggle('hidden', id !== name);
  }
  $('app').classList.toggle('menu', name !== null);
}

function statsHtml() {
  const best = missions.save.bestWanted;
  const rs = runStats();
  return `<b>MONEY</b> ${formatMoney(rs.money)} · <b>RANK</b> ${missions.save.rank} · <b>RESPECT</b> ${missions.save.respect}<br>`
    + `<b>JOBS</b> ${rs.jobs}/${MISSIONS.length} · <b>BEST HEAT</b> ${best ? '★'.repeat(best) : 'CLEAN'}<br>`
    + `<b>RUN</b> ${rs.shots} SHOTS · ${rs.peds} CIVILIANS DOWN · PEAK ${rs.peak ? '★'.repeat(rs.peak) : 'CLEAN'}<br>`
    + `<b>CITY</b> ${city.countColliders()} FOOTPRINTS · <b>FPS</b> ${fps}`;
}

function startPlay(index = null) {
  if (index !== null) missions.setMission(index);
  missions.done = false;
  police.reset();
  traffic.clearRival();
  arsenal.reset(true);
  player.health = 100;
  player.armour = 40;
  player.stamina = 100;
  player.enginePct = 96;
  player.tiresPopped = false;
  player.spawnCar(90, 80, 0);
  city.addHeadlights(player.car);
  player.exitCar();
  player.camYaw = -Math.PI * 0.5;   // face the hero car on the street
  player.camPitch = 0.32;
  mctx.shotsFired = 0;
  mctx.pedDowns = 0;
  mctx.wantedPeak = 0;
  wreckWarned = false;
  cleanArmed = false;
  ramHits = 0;
  nextMissionTimer = 0;
  storyTimer = 0;
  state = 'play';
  showScreen(null);
  $('app').classList.remove('shot');
  hud.center(missions.mission().name, missions.mission().brief, '', 3.4);
  hud.ticker(missionGiver(), missionAvatar(), missions.mission().brief);
  sound.ensure();
  sound.engineStart();
  input.lock();
}

function togglePause() {
  if (state === 'play') {
    state = 'pause';
    showScreen('pauseScreen');
    $('pauseStats').innerHTML = statsHtml();
    missions.persist();
    input.unlock();
  } else if (state === 'pause') {
    state = 'play';
    showScreen(null);
    input.lock();
  }
}

function togglePhone() {
  if (state === 'play') {
    stateBeforePhone = 'play';
    state = 'phone';
    showScreen('phoneScreen');
    input.unlock();
  } else if (state === 'phone') {
    state = stateBeforePhone;
    showScreen(null);
    if (state === 'play') input.lock();
  }
}

function endGame(kind) {
  if (state === 'end') return;
  state = 'end';
  input.unlock();
  police.reset();
  if (kind === 'busted') {
    sound.busted();
    $('endTitle').textContent = 'BUSTED';
    $('endText').textContent = 'Port Azul PD finally caught Marlow Reyes. The crew will talk, the car will be crushed, and the city goes back to sleep.';
  } else {
    sound.wasted();
    $('endTitle').textContent = 'WASTED';
    $('endText').textContent = 'Marlow Reyes goes down on the neon asphalt. Roxy will hear about it by morning.';
  }
  $('endStats').innerHTML = statsHtml();
  showScreen('endScreen');
  missions.persist();
}

// ---- phone -----------------------------------------------------------------
const CONTACTS = [
  { name: 'ROXY', avatar: 'R', text: 'Keys are in the courier van. Bring it back in one piece, Marlow.' },
  { name: 'LOURDES', avatar: 'L', text: 'The manifest is in the crane office. In and out, mijo.' },
  { name: 'PORT AZUL PD', avatar: 'P', text: 'Dispatch: suspect last seen on Neon Avenue. Units en route.' },
  { name: 'RIVAL CREW', avatar: 'X', text: 'You run these streets? Cute. The docks belong to us now.' },
];
function buildPhone() {
  const el = $('phoneList');
  el.innerHTML = '';
  for (const c of CONTACTS) {
    const d = document.createElement('div');
    d.className = 'mi';
    d.style.display = 'flex';
    d.style.alignItems = 'center';
    d.style.gap = '10px';
    d.innerHTML = `<span style="width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:900;background:rgba(255,255,255,.12)">${c.avatar}</span>`
      + `<span><b style="color:#5ff2ff">${c.name}</b><br><span style="color:#cfe3ff;font-size:12px">${c.text}</span></span>`;
    d.onclick = () => {
      hud.ticker(c.name, c.avatar, c.text, 7);
      sound.radioBlip();
      togglePhone();
    };
    el.appendChild(d);
  }
}
buildPhone();

// ---- mission list on the title screen --------------------------------------
function buildMissionList() {
  const el = $('missionList');
  el.innerHTML = '';
  MISSIONS.forEach((m, i) => {
    const done = missions.save.completed.includes(m.id);
    const d = document.createElement('div');
    d.className = 'mi' + (done ? ' done' : '');
    d.innerHTML = `<span>${m.name}</span><span class="tag">$${m.reward.toLocaleString('en-US')}</span>`;
    d.onclick = () => { sound.ensure(); sound.click(); startPlay(i); };
    el.appendChild(d);
  });
}

// ---- HUD -------------------------------------------------------------------
function radioLine() {
  if (!player.inCar) return 'ON FOOT · RADIO OFF';
  const stations = ['KNEON 98.5 — SYNTHWAVE', 'WAVE 103 — COASTAL POP', 'RADIO PUERTO — SALSA', 'KOLD 92 — CLASSIC ROCK'];
  return stations[Math.floor(simTime / 40) % stations.length];
}

function updateHud() {
  const m = missions.mission();
  const st = missions.stage();
  if (m && st) hud.setMission(m, st, missions.stageIndex, missions.stageProgress(mctx));
  hud.setWanted(police.wanted, police.nearestPoliceDist(player.x, player.z) < 55 || police.wanted >= 3);
  hud.setStats(
    missions.save.money, player.health, player.armour, player.stamina,
    arsenal.current(), arsenal.currentAmmo(), missions.save.rank, missions.save.respect);
  hud.setSlots(arsenal.index, arsenal.owned);
  // A dry weapon is called out on the HUD rather than only by the click sound.
  hud.setDryFire(!arsenal.hasLiveWeapon);
  hud.setDispatch(police.dispatchList(player.x, player.z));
  hud.setSpeed(player.inCar ? player.speedKmh() : 0, player.inCar ? player.carName : 'ON FOOT', player.enginePct, radioLine());
  hud.setClock(clockMin);
  hud.setMarkerDist(mctx.markerDist);
  const loc = city.locationAt(player.x, player.z);
  hud.setLocation(loc.street, loc.district);
  hud.setArrest(police.arrest);
  hud.setHealthTone(player.health);
  hud.setPrompt(promptText());
  hud.setCrosshair(state === 'play' && !player.inCar);
  hud.setFps(fps);
  const blips = [];
  for (const c of police.cruisers) if (!c.disabled) blips.push({ x: c.x, z: c.z });
  if (police.tank) blips.push({ x: police.tank.x, z: police.tank.z });
  hud.drawMinimap(player.x, player.z, player.heading, blips, missions.marker,
    police.heli ? { x: police.heli.mesh.position.x, z: police.heli.mesh.position.z } : null,
    police.roadblock ? { x: police.roadblock.x, z: police.roadblock.z, heading: police.roadblock.heading } : null);
}

// ---- input -----------------------------------------------------------------
/** Keys that work in every state: mute, phone, pause. */
function handleMetaInput() {
  if (input.pressed('KeyM')) {
    muted = !muted;
    sound.setMuted(muted);
    hud.toast(muted ? 'SOUND OFF' : 'SOUND ON');
  }
  if (input.pressed('Tab')) { togglePhone(); return; }
  if (input.pressed('KeyP') || (input.pressed('Escape') && !input.locked)) togglePause();
}

function handleInput(dt) {
  if (state !== 'play') return;

  if (input.pressed('KeyC')) camRig.toggle();
  if (input.pressed('KeyE')) onEnterExit();
  if (input.pressed('KeyF')) onSteal();
  if (input.pressed('KeyH')) sound.honk();
  if (input.pressed('KeyQ')) melee();
  if (input.pressed('KeyR')) { if (arsenal.startReload()) sound.click(); }
  // The mouse wheel cycles the owned weapons, the way a weapon wheel should.
  const wheel = input.takeWheel();
  if (wheel) {
    if (arsenal.cycle(wheel > 0 ? 1 : -1)) sound.click();
    else sound.denied();
  }
  for (let i = 0; i < 5; i++) {
    if (input.pressed('Digit' + (i + 1))) {
      if (arsenal.select(i)) sound.click();
      else sound.denied();
    }
  }
  if (input.mouseDown || input.mouseClicked) {
    if (arsenal.current().id === 'fists') { if (input.mouseClicked) melee(); }
    else fireWeapon(dt);
  }
  if (input.released('MouseLeft')) arsenal.endClick();
}

// ---- per-frame simulation --------------------------------------------------
function step(dt) {
  simTime += dt;
  clockMin = (clockMin + dt * timeScale) % 1440;
  const s = sunEnv(clockMin);
  env.day = s.day;
  env.dusk = s.dusk;
  env.sunDir.copy(s.sunDir);
  env.focus.set(player.x, player.groundY + 1.6, player.z);

  handleInput(dt);

  const pev = player.update(dt, input, traffic);
  if (pev && pev.crashed) {
    sound.crash(pev.hard);
    hud.damageFlash(pev.hard ? 0.8 : 0.45);
    camRig.shake = Math.max(camRig.shake, pev.hard ? 0.7 : 0.35);
    if (pev.hard) crime(4, 'crash');
  }
  // On-foot sounds: footsteps, jumps and landings.
  for (const e of player.events) {
    if (e.type === 'step') sound.footstep(e.sprint);
    else if (e.type === 'jump') sound.jump();
    else if (e.type === 'land') {
      sound.land(e.strength);
      camRig.shake = Math.max(camRig.shake, 0.14 * e.strength);
    }
  }
  player.events.length = 0;

  traffic.update(dt, player, police.nearestPoliceDist(player.x, player.z) < 60, player.inCar);
  for (const e of traffic.events) {
    if (e.type === 'honk' && Math.hypot(e.x - player.x, e.z - player.z) < 46) sound.honk();
  }

  police.update(dt, player, player.onFoot);
  checkHazards();
  updateMissions(dt);
  updatePickups(dt);
  updateMarker(dt);
  updateSmoke(dt);
  arsenal.update(dt);
  city.update(dt, simTime, env);

  // Audio follows the world.
  sound.setEngine(player.inCar ? player.speedKmh() : 0, player.inCar);
  sound.setSiren(police.wanted > 0, police.nearestPoliceDist(player.x, player.z) < 90, police.wanted);
  sound.radioTick(dt, player.inCar);
  // Tyre screech while the handbrake is sliding the car.
  sound.setScreech(player.inCar && player.handbrakeSlide ? Math.min(1, Math.abs(player.speed) / 22) : 0);

  if (player.health <= 0) endGame('wasted');
  else if (police.arrest >= 1) endGame('busted');
  // A wrecked, stopped ride with no heat is a dead end, not a fail state: say
  // so once and let the player step out, so the session continues instead of
  // stalling in a car that can no longer move.
  if (player.inCar && player.enginePct <= 20.5 && Math.abs(player.speed) < 0.4 && police.wanted === 0) {
    if (!wreckWarned) {
      wreckWarned = true;
      hud.center('ENGINE DEAD', 'This ride is wrecked. Get out and find another.', 'red', 3.4);
      sound.denied();
    }
  } else {
    wreckWarned = false;
  }
}

// Police gunfire damages the player through a callback set here.
police.onShoot = (dmg) => {
  const dead = player.damage(dmg, 'gunfire');
  hud.damageFlash(0.4);
  if (dead) endGame('wasted');
};
// A cruiser PIT or a heavy bump damages the player's car and shakes the camera.
police.onRam = (dmg) => {
  if (player.inCar) {
    player.damage(dmg, 'pit');
    player.enginePct = clamp(player.enginePct - dmg * 0.3, 20, 100);
    player.speed *= 0.86;
    camRig.shake = Math.max(camRig.shake, 0.5);
    hud.damageFlash(0.45);
    sound.crash(false);
  } else {
    player.damage(dmg * 0.5, 'pit');
    camRig.shake = Math.max(camRig.shake, 0.4);
  }
};

// ---- the loop --------------------------------------------------------------
const STEP = 1 / 60;
const MAX_FRAME = 0.25;
let last = performance.now();
let accumulator = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > MAX_FRAME) dt = MAX_FRAME;
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum > 0.5) {
    fps = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
  }

  handleMetaInput();

  if (state === 'play') {
    accumulator += dt;
    let n = 0;
    while (accumulator >= STEP && n < 5) {
      step(STEP);
      accumulator -= STEP;
      n++;
      if (state !== 'play') { accumulator = 0; break; }
    }
    if (n === 5) accumulator = 0;
  } else if (state === 'title' || state === 'end') {
    idleTime += dt;
    const s = sunEnv(clockMin);
    env.day = s.day;
    env.dusk = s.dusk;
    env.sunDir.copy(s.sunDir);
    env.focus.set(player.x, player.groundY + 1.6, player.z);
    traffic.update(dt, player, false, player.inCar);
    city.update(dt, idleTime, env);
    updateMarker(dt);
    updateSmoke(dt);
    arsenal.update(dt);
  }

  camRig.update(dt, freeCam ?? ((state === 'title' || state === 'end') ? MENU_CAM : null));
  fill.position.copy(camera.position);
  fill.target.position.set(player.x, player.groundY + 1.5, player.z);
  fill.target.updateMatrixWorld();
  fill.intensity = 0.62 - 0.3 * env.day;
  if (state === 'play' || state === 'pause' || state === 'phone') updateHud();
  hud.update(dt);
  // The menu clock tracks the (idle-advancing) time of day too.
  if (state === 'title' || state === 'end') paintTitleClock();
  renderer.render(scene, camera);
  if (!bootHidden) { bootHidden = true; bootEl?.classList.add('gone'); }

  input.beginFrame();
  input.endFrame();

  if (shotFrames > 0) {
    shotFrames--;
    if (shotFrames === 0) window.__shotReady = true;
  }
}

// ---- wiring ----------------------------------------------------------------
$('playBtn').onclick = () => { sound.ensure(); sound.click(); startPlay(0); };
$('continueBtn').onclick = () => { sound.ensure(); sound.click(); startPlay(); };
$('resumeBtn').onclick = () => { sound.click(); togglePause(); };
$('restartBtn').onclick = () => {
  sound.click();
  missions.restartMission();
  police.reset();
  cleanArmed = false; ramHits = 0;
  state = 'play';
  showScreen(null);
  input.lock();
  hud.center(missions.mission().name, missions.mission().brief, '', 3.0);
};
$('resetBtn').onclick = () => {
  sound.click();
  missions.resetSave();
  police.reset();
  arsenal.reset();
  player.health = 100; player.armour = 40; player.stamina = 100;
  cleanArmed = false; ramHits = 0;
  state = 'play';
  showScreen(null);
  input.lock();
  hud.toast('PROGRESS RESET');
  hud.center(missions.mission().name, missions.mission().brief, '', 3.0);
};
$('quitBtn').onclick = () => {
  sound.click();
  state = 'title';
  buildMissionList();
  showScreen('startScreen');
  input.unlock();
};
$('againBtn').onclick = () => { sound.click(); startPlay(missions.missionIndex); };
$('menuBtn').onclick = () => {
  sound.click();
  state = 'title';
  buildMissionList();
  showScreen('startScreen');
  input.unlock();
};
$('phoneClose').onclick = () => { sound.click(); togglePhone(); };

canvas.addEventListener('mousedown', () => {
  sound.ensure();
  if (state === 'play' && !input.locked) input.lock();
});
document.addEventListener('pointerlockchange', () => {
  // Losing the pointer (ESC) pauses the game rather than leaving it running.
  if (!document.pointerLockElement && state === 'play') togglePause();
});

buildMissionList();
showScreen('startScreen');

// ---- screenshot presets ----------------------------------------------------
/** Fixed steps a staged shot runs before it is captured, so a preset is a
 *  deterministic scene rather than whatever the first frames happened to show. */
const SHOT_SETTLE_STEPS = 110;
const SHOTS = {
  start: {
    screen: 'title', time: 18 * 60 + 45, pos: [30, 96],
    cam: { dist: 34, pitch: 0.26, spin: 0.08, yaw: Math.PI * 0.78 },
  },
  play: { screen: 'none', time: 18 * 60 + 18, car: [30, 26, Math.PI * 0.05] },
  // A pursuit reads as a pursuit only if a cruiser is actually in frame and
  // the car is rolling, so the preset seeds both.
  chase: {
    screen: 'none', time: 21 * 60 + 35, car: [30, -14, 0], wanted: 3,
    speed: 24, units: [[30, -34], [46, -28]],
  },
  boardwalk: {
    screen: 'none', time: 18 * 60 + 25, pos: [30, 214], park: [18, 209, Math.PI / 2],
    cam: { dist: 22, pitch: 0.16, spin: 0.02, yaw: Math.PI, look: 6 },
  },
  docks: {
    screen: 'none', time: 17 * 60 + 12, pos: [-228, 8],
    // South of the player looking north across the yard: the near gantry
    // crane's two legs and beam fill the left of frame, the container stacks
    // the right, and the quay wall sits behind the camera so it does not eat
    // the foreground.
    cam: { dist: 15, pitch: 0.12, spin: 0.02, yaw: 0, look: 2.0 },
  },
  night: {
    screen: 'none', time: 23 * 60 + 5, car: [30, 40, 0], wanted: 4,
    cam: { dist: 12, pitch: 0.2, spin: 0.05, yaw: Math.PI * 0.9 },
  },
};

/** True when a walker could stand at (x,z) — clear of buildings and surf. */
function standable(x, z) {
  return !city.hitsBuilding(x, z, 1.1) && !city.isWater(x, z);
}

/**
 * Nudge a staged position out of a footprint. The port is full of container
 * stacks, and a preset that lands inside one puts the camera inside the
 * player's head, so the preset is a hint and this search finds the nearest
 * clear ground.
 */
function clearSpot(x, z) {
  if (standable(x, z)) return [x, z];
  for (let r = 3; r <= 30; r += 3) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const cx = x + Math.cos(a) * r, cz = z + Math.sin(a) * r;
      if (standable(cx, cz)) return [cx, cz];
    }
  }
  return [x, z];
}

function applyShot(name) {
  const s = SHOTS[name];
  if (!s) return false;
  if (s.time != null) clockMin = s.time;
  paintClock();
  paintTitleClock();
  freeCam = s.cam || null;
  $('app').classList.add('shot');
  if (s.screen === 'title') {
    state = 'title';
    buildMissionList();
    showScreen('startScreen');
  } else {
    state = 'play';
    showScreen(null);
  }
  police.reset();
  if (s.park) {
    // A parked hero car stays in the frame (the boardwalk shot is staged with
    // one); spawnCar steps straight out of it again.
    player.spawnCar(s.park[0], s.park[1], s.park[2]);
    player.exitCar();
  }
  if (s.car) {
    player.spawnCar(s.car[0], s.car[1], s.car[2]);
    player.speed = s.speed ?? 0;
  } else if (s.pos) {
    if (!s.park && player.car) { scene.remove(player.car); player.car = null; }
    player.inCar = false;
    player.onFoot = true;
    player.body.visible = true;
    const [px, pz] = clearSpot(s.pos[0], s.pos[1]);
    player.x = px;
    player.z = pz;
    player.heading = Math.PI;
    player.camYaw = s.cam ? (s.cam.yaw ?? Math.PI) : Math.PI;
    camRig.yaw = player.camYaw;
    player.body.position.set(player.x, city.groundHeightAt(player.x, player.z), player.z);
  }
  if (s.wanted) {
    police.heat = 0;
    police.wanted = 0;
    police.addHeat(s.wanted >= 5 ? 92 : s.wanted >= 3 ? 55 : 25, 'shot');
  }
  if (s.units) {
    for (const [ux, uz] of s.units) police.spawnCruiser(player.x, player.z, { x: ux, z: uz });
  }
  /** A staged shot settles immediately: one environment pass with the pinned
   *  clock, so stars, lamp pools and window glow are in place on frame one. */
  const envNow = sunEnv(clockMin);
  env.day = envNow.day;
  env.dusk = envNow.dusk;
  env.sunDir.copy(envNow.sunDir);
  city.update(0.016, simTime, env);
  // Put the camera straight on its subject so the first frame is framed.
  camRig.pos.set(player.x + 10, player.groundY + 6, player.z + 14);
  camRig.look.set(player.x, player.groundY + 1.6, player.z);
  // The title preset keeps its menu orbit; everything else settles for real.
  if (s.screen === 'title') { shotFrames = 24; return true; }
  // Run the actual fixed-step simulation for a moment and let the camera rig
  // catch up, then paint once. The captured frame is the same whether the tab
  // managed one rAF tick or a thousand, which is what makes the four shots in
  // screenshots/ reproducible from a ?shot= query alone. The clock is pinned
  // while it runs, so ?time=HH:MM is the hour on the clock in the picture.
  const savedTimeScale = timeScale;
  timeScale = 0;
  for (let i = 0; i < SHOT_SETTLE_STEPS; i++) {
    step(STEP);
    camRig.update(STEP, freeCam);
  }
  timeScale = savedTimeScale;
  updateHud();
  renderer.render(scene, camera);
  window.__shotReady = true;
  return true;
}

const shotName = params.get('shot');
if (shotName) applyShot(shotName);

// ---- debug handle ----------------------------------------------------------
window.__game = {
  get state() { return state; },
  get fps() { return fps; },
  get simTime() { return simTime; },
  renderer,
  scene,
  camera,
  city,
  player,
  police,
  traffic,
  missions,
  arsenal,
  startPlay,
  endGame,
  /** Pin the clock (minutes since midnight) — used by the screenshot presets. */
  setClock(minutes) {
    clockMin = ((minutes % 1440) + 1440) % 1440;
    paintClock();
    paintTitleClock();
  },
  /** Toggle the wanted level directly, for staged screenshots. */
  setWanted(stars) {
    police.heat = 0;
    police.wanted = 0;
    police.addHeat(stars >= 5 ? 92 : stars >= 3 ? 55 : stars >= 1 ? 25 : 0, 'shot');
  },
  ff() {
    nextMissionTimer = Math.min(nextMissionTimer, 0.01);
    storyTimer = Math.min(storyTimer, 0.01);
  },
  /** Advance the simulation n fixed steps without waiting on the frame rate. */
  step(n = 1) {
    for (let i = 0; i < n; i++) {
      if (state !== 'play') break;
      step(STEP);
    }
  },
};
requestAnimationFrame(frame);
