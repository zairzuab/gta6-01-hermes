// Ambient life: cars cruising the street grid and pedestrians on the sidewalks.
//
// Neither is an agent in the planning sense. A car is a lane (an axis plus a
// direction) with a speed; a pedestrian is a heading with a walk cycle. The
// reaction layer around that cheap core is what makes them read as alive:
//
//   * cars brake for the player, for each other and for anyone in the road,
//     light their brake lamps while held back and honk when they stay boxed in;
//   * cars swing onto the cross street at intersections instead of snapping;
//   * a burst of chaos (a shot, a steal, a ram) sets a panic field that sends
//     nearby people sprinting directly away and makes traffic hurry off;
//   * a person can be punched, shot or run down, falls, and stays as scenery
//     until the crowd has refilled enough to retire the oldest bodies.
//
// The module also owns the chase job's rival courier, a scripted runner that
// keeps its distance and is rammed three times to end the job.
import * as THREE from 'three';
import { makeCar, makePerson } from './vehicles.js';
import { CITY_HALF, PITCH, STREET_W, nearestStreet } from './city.js';
import { disposeGroup } from './util.js';

const SHIRTS = [0xd84a4a, 0x4a7ad8, 0x4ad87a, 0xd8c84a, 0xd84ad8, 0xf2f2f2, 0x333333, 0xff8c42];
const PANTS = [0x2a3a55, 0x3a3a3a, 0x55402a, 0x22303f];

// Sidewalk offset from a street centreline, just outside the kerb.
const WALK_OFFSET = 9.4;
// Population targets and the number of bodies kept before the oldest go.
const CAR_COUNT = 14;
const PED_COUNT = 26;
const AVENUE_PED_COUNT = 14;
const PED_TARGET = 40;
const PED_BODY_CAP = 18;

const rnd = () => Math.random();
const rand = (lo, hi) => lo + rnd() * (hi - lo);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const side = () => (rnd() < 0.5 ? -1 : 1);

export class Traffic {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.cars = [];
    this.peds = [];
    this.events = [];           // honks raised this frame: {type:'honk', x, z}
    this.rival = null;
    this.spawnCars(CAR_COUNT);
    this.spawnPeds(PED_COUNT);
    this.spawnAvenuePeds(AVENUE_PED_COUNT);
    this.spawnParked();
    this.pedTarget = PED_TARGET; // the sidewalks refill so a long session stays alive
  }

  // =========================================================================
  // Queries
  // =========================================================================

  /** How many pedestrians are still on their feet. */
  alivePeds() {
    let n = 0;
    for (const p of this.peds) if (!p.dead) n++;
    return n;
  }

  /**
   * The nearest living pedestrian to a point (for melee and gunfire).
   * Returns null when nothing is within maxDist.
   */
  nearestPed(x, z, maxDist = Infinity) {
    let best = null, bestD = maxDist;
    for (const p of this.peds) {
      if (p.dead) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /** The nearest rideable car; a burnt-out wreck is scenery, not a ride. */
  nearestCar(x, z, maxDist = 6) {
    let best = null, bestD = maxDist;
    for (const c of this.cars) {
      if (c.dead) continue;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  // =========================================================================
  // Placement helpers
  // =========================================================================

  /** A random point on a street, with the axis it runs along and a heading. */
  randomStreetPoint() {
    const i = 1 + Math.floor(rnd() * 6);
    const j = 1 + Math.floor(rnd() * 6);
    const along = (rnd() - 0.5) * (PITCH - STREET_W);
    if (rnd() < 0.5) {
      return { x: -CITY_HALF + i * PITCH, z: -CITY_HALF + j * PITCH + along, axis: 'z', dir: side() };
    }
    return { x: -CITY_HALF + i * PITCH + along, z: -CITY_HALF + j * PITCH, axis: 'x', dir: side() };
  }

  /** Heading on the mesh that faces travel along (axis, dir). */
  static headingFor(axis, dir) {
    return axis === 'z' ? (dir > 0 ? Math.PI : 0) : (dir > 0 ? -Math.PI / 2 : Math.PI / 2);
  }

  /** A point beside a street centreline, on one sidewalk or the other. */
  _sidewalkPoint(p) {
    const s = side();
    return p.axis === 'z'
      ? { x: p.x + s * WALK_OFFSET, z: p.z }
      : { x: p.x, z: p.z + s * WALK_OFFSET };
  }

  // =========================================================================
  // Spawning
  // =========================================================================

  spawnCars(n) {
    for (let i = 0; i < n; i++) {
      const p = this.randomStreetPoint();
      const kind = rnd() < 0.14 ? 'taxi' : 'traffic';
      const mesh = makeCar(kind, i);
      mesh.position.set(p.x, 0, p.z);
      mesh.rotation.y = Traffic.headingFor(p.axis, p.dir);
      this.scene.add(mesh);
      this.cars.push({
        mesh, x: p.x, z: p.z, axis: p.axis, dir: p.dir,
        speed: rand(7, 12), targetSpeed: rand(8, 14),
        heading: mesh.rotation.y, scared: 0, dead: false, hp: 60,
        honkTimer: rand(0, 4), braking: false, parked: false,
      });
    }
  }

  spawnPeds(n) {
    for (let i = 0; i < n; i++) {
      const s = this._sidewalkPoint(this.randomStreetPoint());
      this._addPed(s.x, s.z, rand(0, Math.PI * 2),
        SHIRTS[i % SHIRTS.length], PANTS[(i + 1) % PANTS.length]);
    }
  }

  /** Pedestrians strolling the main avenue's sidewalks, for busy chase shots. */
  spawnAvenuePeds(n) {
    for (let i = 0; i < n; i++) {
      const s = side();
      this._addPed(
        30 + s * (STREET_W / 2 + 2.4 + rand(0, 2.6)),
        -CITY_HALF + 20 + rnd() * (2 * CITY_HALF - 40),
        rnd() < 0.5 ? 0 : Math.PI,
        SHIRTS[i % SHIRTS.length], PANTS[i % PANTS.length]);
    }
  }

  /** Parked cars along the kerb, ready to be stolen. */
  spawnParked() {
    for (const spot of this.city.parkedSpots) {
      const mesh = makeCar('traffic', Math.floor(rnd() * 8));
      mesh.position.set(spot.x, 0, spot.z);
      mesh.rotation.y = spot.heading;
      this.scene.add(mesh);
      this.cars.push({
        mesh, x: spot.x, z: spot.z, axis: 'z',
        dir: spot.heading === Math.PI ? 1 : -1,
        speed: 0, targetSpeed: rand(8, 13), heading: spot.heading,
        scared: 0, dead: false, parked: true, hp: 60, honkTimer: 0, braking: false,
      });
    }
  }

  /** Build one walker, add it to the scene and return its record. */
  _addPed(x, z, heading, shirt, pants) {
    const mesh = makePerson(shirt ?? pick(SHIRTS), pants ?? pick(PANTS));
    mesh.position.set(x, 0, z);
    mesh.rotation.y = heading;
    this.scene.add(mesh);
    const ped = {
      mesh, x, z, heading,
      speed: rand(1.1, 1.9),
      walkPhase: rand(0, 6), panic: 0, dead: false, hp: 30,
    };
    this.peds.push(ped);
    return ped;
  }

  // =========================================================================
  // The crowd: refill and body retirement
  // =========================================================================

  /**
   * Refill the crowd away from the player. Bodies are scenery, but this list
   * is walked every frame by gunfire, melee and the traffic update, so it is
   * capped: once the sidewalks have refilled, the oldest bodies are retired.
   */
  respawnPeds(playerPos) {
    let alive = 0, dead = 0;
    for (const p of this.peds) { if (p.dead) dead++; else alive++; }
    if (dead > PED_BODY_CAP) this._clearDeadPeds(dead - PED_BODY_CAP);
    if (alive >= this.pedTarget) return;
    for (let i = 0; i < 2; i++) {
      const p = this.city.randomStreetPoint(playerPos.x, playerPos.z, 70);
      const s = this._sidewalkPoint(p);
      this._addPed(s.x, s.z, rand(0, Math.PI * 2));
    }
  }

  /** Remove the oldest `n` bodies from the scene and the ped list. */
  _clearDeadPeds(n) {
    let removed = 0;
    for (let i = this.peds.length - 1; i >= 0 && removed < n; i--) {
      const p = this.peds[i];
      if (!p.dead) continue;
      this.scene.remove(p.mesh);
      disposeGroup(p.mesh);
      this.peds.splice(i, 1);
      removed++;
    }
  }

  // =========================================================================
  // The chase job's rival courier
  // =========================================================================

  spawnRival(x, z) {
    const mesh = makeCar('player', 0);
    mesh.userData.name = 'RIVAL COURIER';
    mesh.userData.bodyColor = 0x2ec4b6;
    mesh.userData.setDamage(0);
    mesh.position.set(x, 0, z);
    this.scene.add(mesh);
    this.rival = {
      mesh, x, z, axis: 'x', dir: 1, heading: Math.PI / 2, speed: 0,
      targetSpeed: 30, hp: 3, dead: false, stopped: false, turnTimer: 0,
    };
    return this.rival;
  }

  clearRival() {
    if (!this.rival) return;
    this.scene.remove(this.rival.mesh);
    this.rival = null;
  }

  // =========================================================================
  // Queries and mutations the game uses
  // =========================================================================

  /** Hand a traffic car to the player; it leaves the traffic list. */
  steal(car) {
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
    if (car.parked) car.parked = false;
    return car.mesh;
  }

  /** Chaos nearby: pedestrians run and cars speed up or swerve. */
  panicNear(x, z, radius = 26) {
    for (const p of this.peds) {
      if (!p.dead && Math.hypot(p.x - x, p.z - z) < radius) p.panic = rand(3, 5);
    }
    for (const c of this.cars) {
      if (Math.hypot(c.x - x, c.z - z) < radius) c.scared = 2.5;
    }
  }

  /** A pedestrian falls (shot or run down). Returns true when it killed them. */
  hitPed(ped, damage) {
    if (ped.dead) return false;
    ped.hp -= damage;
    ped.panic = 4;
    if (ped.hp <= 0) { this.dropPed(ped); return true; }
    return false;
  }

  dropPed(ped) {
    if (ped.dead) return;
    ped.dead = true;
    ped.mesh.rotation.x = Math.PI / 2;
    ped.mesh.position.y = 0.25;
  }

  /** Damage a traffic car; at zero it stalls and burns out. */
  damageCar(car, amount) {
    if (car.dead) return false;
    car.hp -= amount;
    car.scared = Math.max(car.scared, 2);
    if (car.hp <= 0) {
      car.dead = true;
      car.speed = 0;
      car.targetSpeed = 0;
      car.mesh.userData.setDamage(1);
      return true;
    }
    car.mesh.userData.setDamage(1 - car.hp / 60);
    return false;
  }

  // =========================================================================
  // Per-frame simulation
  // =========================================================================

  update(dt, playerPos, policeNear, playerInCar) {
    this.events.length = 0;
    const limit = this.city.worldLimit();
    const playerSpeed = Math.abs(playerPos.speed || 0);

    this.updateCars(dt, playerPos, playerSpeed, policeNear, limit);
    this.updatePeds(dt, playerPos, playerSpeed, playerInCar);
    this.respawnPeds(playerPos);
    this.updateRival(dt, playerPos);
  }

  // ---- traffic cars --------------------------------------------------------

  updateCars(dt, playerPos, playerSpeed, policeNear, limit) {
    for (const c of this.cars) {
      if (c.dead) continue;

      // Brake lamps: a car held back shows lit brakes — the cheapest way to
      // read a queue at night.
      const brakeMat = c.mesh.userData.brakeMat;
      if (brakeMat) brakeMat.emissiveIntensity = c.braking ? 2.6 : 1.6;

      let want = c.parked ? 0 : c.targetSpeed;
      const ahead = 10;
      const ax = c.axis === 'z' ? c.x : c.x + c.dir * ahead;
      const az = c.axis === 'z' ? c.z + c.dir * ahead : c.z;
      let blocked = false;
      if (!c.parked && Math.hypot(playerPos.x - ax, playerPos.z - az) < 6.0) blocked = true;
      if (!c.parked && !blocked) {
        for (const p of this.peds) {
          if (!p.dead && Math.hypot(p.x - ax, p.z - az) < 4.5) { blocked = true; break; }
        }
      }
      if (!c.parked && !blocked) {
        for (const o of this.cars) {
          if (o === c || o.dead || o.axis !== c.axis || o.dir !== c.dir) continue;
          const along = c.axis === 'z' ? (o.z - c.z) * c.dir : (o.x - c.x) * c.dir;
          const lateral = c.axis === 'z' ? Math.abs(o.x - c.x) : Math.abs(o.z - c.z);
          if (along > 0 && along < 12 && lateral < 3.4) { blocked = true; break; }
        }
      }
      if (policeNear && !c.parked) want = Math.min(want, 17);
      if (c.scared > 0) { want = c.parked ? 12 : 15; c.scared -= dt; }
      if (blocked) want = 0;
      c.speed += (want - c.speed) * Math.min(1, dt * (blocked ? 5 : 1.6));
      c.braking = blocked;
      // A scared but unimpeded car is reversing out of trouble, not standing
      // on its brakes: only a real obstruction lights the brakes.
      if (c.scared > 0 && !blocked) c.braking = false;

      c.honkTimer -= dt;
      if (blocked && !c.parked && c.honkTimer <= 0) {
        c.honkTimer = rand(2, 6);
        this.events.push({ type: 'honk', x: c.x, z: c.z });
      }

      if (c.axis === 'z') {
        c.z += c.dir * c.speed * dt;
        if (c.z > CITY_HALF + 12) c.z = -CITY_HALF - 12;
        if (c.z < -CITY_HALF - 12) c.z = CITY_HALF + 12;
      } else {
        c.x += c.dir * c.speed * dt;
        if (c.x > CITY_HALF + 12) c.x = -CITY_HALF - 12;
        if (c.x < -CITY_HALF - 12) c.x = CITY_HALF + 12;
      }
      // Turn at an intersection now and then, so the grid is not a conveyor.
      // turnCar runs every frame while a turn is in progress (turnDir set).
      if (!c.parked && c.speed > 2 && (c.turnDir !== undefined || rnd() < dt * 0.09)) {
        this.turnCar(c, dt);
      }
      c.x = Math.max(limit.minX, Math.min(limit.maxX, c.x));
      c.z = Math.max(limit.minZ, Math.min(limit.maxZ, c.z));
      c.mesh.position.set(c.x, 0, c.z);
      c.mesh.rotation.y = Traffic.headingFor(c.axis, c.dir);
      for (const w of c.mesh.userData.wheels) w.rotation.x += c.speed * dt * 2.2;
    }
  }

  /**
   * Swing a traffic car onto the cross street rather than snapping, so the
   * grid reads as a road network. Called every frame while a turn runs.
   */
  turnCar(c, dt) {
    const crossAxis = c.axis === 'z' ? 'x' : 'z';
    if (c.turnDir === undefined) c.turnDir = side();
    const step = 9 * dt;
    const lateral = c.axis === 'z' ? c.x : c.z;
    const target = nearestStreet(lateral) ?? lateral;
    const d = target - lateral;
    if (Math.abs(d) > 1.0) {
      if (c.axis === 'z') c.x += Math.sign(d) * Math.min(Math.abs(d), step);
      else c.z += Math.sign(d) * Math.min(Math.abs(d), step);
    } else {
      c.axis = crossAxis;
      c.dir = c.turnDir;
      c.turnDir = undefined;
    }
  }

  // ---- pedestrians ---------------------------------------------------------

  updatePeds(dt, playerPos, playerSpeed, playerInCar) {
    for (const p of this.peds) {
      if (p.dead) continue;
      const dp = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
      // A speeding car in the street is a threat even at a distance.
      if (playerInCar && playerSpeed > 8 && dp < 16) p.panic = Math.max(p.panic, 2.4);
      let speed = p.speed;
      if (p.panic > 0) {
        p.panic -= dt;
        speed = 3.6;
        // Run directly away from the threat.
        p.heading = Math.atan2(p.x - playerPos.x, p.z - playerPos.z);
      }
      p.x += Math.sin(p.heading) * speed * dt;
      p.z += Math.cos(p.heading) * speed * dt;
      if (Math.abs(p.x) > CITY_HALF + 8 || Math.abs(p.z) > CITY_HALF + 8
          || this.city.hitsBuilding(p.x, p.z, 1) || this.city.isWater(p.x, p.z)) {
        p.heading += Math.PI / 2 + (rnd() - 0.5);
      }
      if (p.panic <= 0 && rnd() < dt * 0.09) p.heading += (rnd() - 0.5) * 1.2;
      p.walkPhase += speed * dt * 4;
      p.mesh.position.set(p.x, 0, p.z);
      p.mesh.rotation.y = p.heading;
      const swing = Math.sin(p.walkPhase) * 0.5;
      p.mesh.userData.legs[0].rotation.x = swing;
      p.mesh.userData.legs[1].rotation.x = -swing;
      p.mesh.userData.arms[0].rotation.x = -swing * 0.7;
      p.mesh.userData.arms[1].rotation.x = swing * 0.7;
    }
  }

  /** The rival courier runs the grid away from the player. */
  updateRival(dt, playerPos) {
    const r = this.rival;
    if (!r || r.dead) return;
    r.turnTimer -= dt;
    const dx = r.x - playerPos.x, dz = r.z - playerPos.z;
    const dist = Math.hypot(dx, dz);
    // Pick the axis that increases the distance from the player.
    if (r.turnTimer <= 0) {
      r.turnTimer = rand(0.8, 1.6);
      const opts = [];
      if (Math.abs(dx) > Math.abs(dz)) opts.push({ axis: 'x', dir: dx > 0 ? 1 : -1 });
      else opts.push({ axis: 'z', dir: dz > 0 ? 1 : -1 });
      opts.push({ axis: 'x', dir: side() });
      opts.push({ axis: 'z', dir: side() });
      const pickDir = opts[Math.floor(rnd() * opts.length)];
      r.axis = pickDir.axis; r.dir = pickDir.dir;
    }
    const want = r.stopped ? 0 : (dist < 26 ? r.targetSpeed * 1.15 : r.targetSpeed * 0.8);
    r.speed += (want - r.speed) * Math.min(1, dt * 1.4);
    if (r.axis === 'x') {
      r.x += r.dir * r.speed * dt;
      if (r.x > CITY_HALF + 10) { r.x = CITY_HALF + 10; r.dir = -1; }
      if (r.x < -CITY_HALF - 10) { r.x = -CITY_HALF - 10; r.dir = 1; }
    } else {
      r.z += r.dir * r.speed * dt;
      if (r.z > CITY_HALF + 10) { r.z = CITY_HALF + 10; r.dir = -1; }
      if (r.z < -CITY_HALF - 10) { r.z = -CITY_HALF - 10; r.dir = 1; }
    }
    r.heading = Traffic.headingFor(r.axis, r.dir);
    r.mesh.position.set(r.x, 0, r.z);
    r.mesh.rotation.y = r.heading;
    for (const w of r.mesh.userData.wheels) w.rotation.x += r.speed * dt * 2.2;
    if (r.stopped) r.mesh.userData.setDamage(1);
  }
}
