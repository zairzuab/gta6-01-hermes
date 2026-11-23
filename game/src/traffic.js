// Traffic: cars cruising the street grid and pedestrians on the sidewalks.
// Both are deliberately cheap — lane-following with a heading and a speed —
// but they brake for the player and each other, honk when boxed in, turn at
// intersections, panic when there is chaos, and can be car-jacked or run
// down, so the city feels alive without a full agent simulation.
import * as THREE from 'three';
import { makeCar, makePerson } from './vehicles.js';
import { CITY_HALF, PITCH, STREET_W, streetCoord, nearestStreet } from './city.js';
import { disposeGroup } from './util.js';

const SHIRTS = [0xd84a4a, 0x4a7ad8, 0x4ad87a, 0xd8c84a, 0xd84ad8, 0xf2f2f2, 0x333333, 0xff8c42];
const PANTS = [0x2a3a55, 0x3a3a3a, 0x55402a, 0x22303f];

export class Traffic {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.cars = [];
    this.peds = [];
    this.events = [];          // {type:'honk', x, z} for the sound bank
    this.spawnCars(14);
    this.spawnPeds(26);
    this.spawnAvenuePeds(14);
    this.spawnParked();
    this.rival = null;
    this.pedTarget = 40;       // the sidewalks refill so a long session stays alive
  }

  /** Top the pedestrian population back up, away from the player. */
  respawnPeds(playerPos) {
    let alive = 0;
    let dead = 0;
    for (const p of this.peds) { if (p.dead) dead++; else alive++; }
    // Bodies on the street are scenery, but this list is walked every frame by
    // gunfire, melee and the traffic update, so it is capped: once the
    // sidewalks have refilled, the oldest bodies are cleared.
    if (dead > 18) this._clearDeadPeds(dead - 18);
    if (alive >= this.pedTarget) return;
    for (let i = 0; i < 2; i++) {
      const p = this.city.randomStreetPoint(playerPos.x, playerPos.z, 70);
      const sx = p.axis === 'z' ? p.x + (Math.random() < 0.5 ? -9.4 : 9.4) : p.x;
      const sz = p.axis === 'x' ? p.z + (Math.random() < 0.5 ? -9.4 : 9.4) : p.z;
      const mesh = makePerson(SHIRTS[Math.floor(Math.random() * SHIRTS.length)],
        PANTS[Math.floor(Math.random() * PANTS.length)]);
      mesh.position.set(sx, 0, sz);
      const heading = Math.random() * Math.PI * 2;
      mesh.rotation.y = heading;
      this.scene.add(mesh);
      this.peds.push(this._ped(mesh, sx, sz, heading));
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

  /** How many pedestrians are still on their feet. */
  alivePeds() {
    let n = 0;
    for (const p of this.peds) if (!p.dead) n++;
    return n;
  }

  /** The nearest living pedestrian to a point (for melee and gunfire). */
  nearestPed(x, z, maxDist = Infinity) {
    let best = null, bestD = maxDist;
    for (const p of this.peds) {
      if (p.dead) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /** Pedestrians strolling the main avenue's sidewalks, for busy chase shots. */
  spawnAvenuePeds(n) {
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = 30 + side * (STREET_W / 2 + 2.4 + Math.random() * 2.6);
      const z = -CITY_HALF + 20 + Math.random() * (2 * CITY_HALF - 40);
      const mesh = makePerson(SHIRTS[i % SHIRTS.length], PANTS[i % PANTS.length]);
      mesh.position.set(x, 0, z);
      const heading = Math.random() < 0.5 ? 0 : Math.PI;
      mesh.rotation.y = heading;
      this.scene.add(mesh);
      this.peds.push(this._ped(mesh, x, z, heading));
    }
  }

  _ped(mesh, x, z, heading) {
    return {
      mesh, x, z, heading, speed: 1.1 + Math.random() * 0.8,
      walkPhase: Math.random() * 6, panic: 0, dead: false, hp: 30,
    };
  }

  randomStreetPoint() {
    const i = 1 + Math.floor(Math.random() * 6);
    const j = 1 + Math.floor(Math.random() * 6);
    const along = (Math.random() - 0.5) * (PITCH - STREET_W);
    if (Math.random() < 0.5) {
      return { x: -CITY_HALF + i * PITCH, z: -CITY_HALF + j * PITCH + along, axis: 'z', dir: Math.random() < 0.5 ? 1 : -1 };
    }
    return { x: -CITY_HALF + i * PITCH + along, z: -CITY_HALF + j * PITCH, axis: 'x', dir: Math.random() < 0.5 ? 1 : -1 };
  }

  spawnCars(n) {
    for (let i = 0; i < n; i++) {
      const p = this.randomStreetPoint();
      const kind = Math.random() < 0.14 ? 'taxi' : 'traffic';
      const mesh = makeCar(kind, i);
      mesh.position.set(p.x, 0, p.z);
      mesh.rotation.y = p.axis === 'z' ? (p.dir > 0 ? Math.PI : 0) : (p.dir > 0 ? -Math.PI / 2 : Math.PI / 2);
      this.scene.add(mesh);
      this.cars.push({
        mesh, x: p.x, z: p.z, axis: p.axis, dir: p.dir,
        speed: 7 + Math.random() * 5, targetSpeed: 8 + Math.random() * 6,
        heading: mesh.rotation.y, scared: 0, dead: false, hp: 60, honkTimer: Math.random() * 4,
      });
    }
  }

  spawnPeds(n) {
    for (let i = 0; i < n; i++) {
      const p = this.randomStreetPoint();
      const mesh = makePerson(SHIRTS[i % SHIRTS.length], PANTS[(i + 1) % PANTS.length]);
      const sx = p.axis === 'z' ? p.x + (Math.random() < 0.5 ? -9.4 : 9.4) : p.x;
      const sz = p.axis === 'x' ? p.z + (Math.random() < 0.5 ? -9.4 : 9.4) : p.z;
      mesh.position.set(sx, 0, sz);
      const heading = Math.random() * Math.PI * 2;
      mesh.rotation.y = heading;
      this.scene.add(mesh);
      this.peds.push(this._ped(mesh, sx, sz, heading));
    }
  }

  /** Parked cars along the kerb, ready to be stolen. */
  spawnParked() {
    for (const spot of this.city.parkedSpots) {
      const mesh = makeCar('traffic', Math.floor(Math.random() * 8));
      mesh.position.set(spot.x, 0, spot.z);
      mesh.rotation.y = spot.heading;
      this.scene.add(mesh);
      this.cars.push({
        mesh, x: spot.x, z: spot.z, axis: 'z', dir: spot.heading === Math.PI ? 1 : -1,
        speed: 0, targetSpeed: 8 + Math.random() * 5, heading: spot.heading,
        scared: 0, dead: false, parked: true, hp: 60, honkTimer: 0,
      });
    }
  }

  /** The chase job's rival courier: a fast car that flees the player. */
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

  nearestCar(x, z, maxDist = 6) {
    let best = null; let bestD = maxDist;
    for (const c of this.cars) {
      // A burnt-out wreck is scenery, not a ride: entering it would strand the
      // player in a car whose engine is already dead.
      if (c.dead) continue;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

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
      if (!p.dead && Math.hypot(p.x - x, p.z - z) < radius) p.panic = 3 + Math.random() * 2;
    }
    for (const c of this.cars) {
      if (Math.hypot(c.x - x, c.z - z) < radius) c.scared = 2.5;
    }
  }

  /**
   * Turn a traffic car at an intersection. A turning car swings onto the cross
   * street rather than snapping, so the grid reads as a road network rather
   * than a conveyor belt.
   */
  turnCar(c, dt) {
    const crossAxis = c.axis === 'z' ? 'x' : 'z';
    // Pick the direction of travel on the cross street the first time only.
    if (c.turnDir === undefined) c.turnDir = Math.random() < 0.5 ? 1 : -1;
    const step = 9 * dt;
    const lateral = c.axis === 'z' ? c.x : c.z;
    const target = nearestStreet(lateral) ?? lateral;
    const d = target - lateral;
    if (Math.abs(d) > 1.0) {
      // Swing onto the cross street's centreline while still driving forward.
      if (c.axis === 'z') c.x += Math.sign(d) * Math.min(Math.abs(d), step);
      else c.z += Math.sign(d) * Math.min(Math.abs(d), step);
    } else {
      c.axis = crossAxis;
      c.dir = c.turnDir;
      c.turnDir = undefined;
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

  update(dt, playerPos, policeNear, playerInCar) {
    this.events.length = 0;
    const limit = this.city.worldLimit();
    // A fast car nearby scares pedestrians even before it hits anything.
    const playerSpeed = Math.abs(playerPos.speed || 0);

    // --- traffic cars ------------------------------------------------------
    for (const c of this.cars) {
      if (c.dead) continue;
      // Brake lights: a car held back by traffic, the player or a panic stop
      // shows lit brakes — the cheapest way to read a queue at night.
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
      // A car that is scared but unimpeded is reversing out of trouble, not
      // standing on its brakes: only a real obstruction lights the brakes.
      if (c.scared > 0 && !blocked) c.braking = false;

      c.honkTimer -= dt;
      if (blocked && !c.parked && c.honkTimer <= 0) {
        c.honkTimer = 2 + Math.random() * 4;
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
      // turnCar is called every frame while a turn is in progress (turnDir set).
      if (!c.parked && c.speed > 2 && (c.turnDir !== undefined || Math.random() < dt * 0.09)) this.turnCar(c, dt);
      c.x = Math.max(limit.minX, Math.min(limit.maxX, c.x));
      c.z = Math.max(limit.minZ, Math.min(limit.maxZ, c.z));
      c.mesh.position.set(c.x, 0, c.z);
      c.mesh.rotation.y = c.axis === 'z' ? (c.dir > 0 ? Math.PI : 0) : (c.dir > 0 ? -Math.PI / 2 : Math.PI / 2);
      for (const w of c.mesh.userData.wheels) w.rotation.x += c.speed * dt * 2.2;
    }

    // --- pedestrians -------------------------------------------------------
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
        p.heading += Math.PI / 2 + (Math.random() - 0.5);
      }
      if (p.panic <= 0 && Math.random() < dt * 0.09) p.heading += (Math.random() - 0.5) * 1.2;
      p.walkPhase += speed * dt * 4;
      p.mesh.position.set(p.x, 0, p.z);
      p.mesh.rotation.y = p.heading;
      const swing = Math.sin(p.walkPhase) * 0.5;
      p.mesh.userData.legs[0].rotation.x = swing;
      p.mesh.userData.legs[1].rotation.x = -swing;
      p.mesh.userData.arms[0].rotation.x = -swing * 0.7;
      p.mesh.userData.arms[1].rotation.x = swing * 0.7;
    }

    this.respawnPeds(playerPos);
    this.updateRival(dt, playerPos);
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
      r.turnTimer = 0.8 + Math.random() * 0.8;
      const opts = [];
      if (Math.abs(dx) > Math.abs(dz)) opts.push({ axis: 'x', dir: dx > 0 ? 1 : -1 });
      else opts.push({ axis: 'z', dir: dz > 0 ? 1 : -1 });
      opts.push({ axis: 'x', dir: Math.random() < 0.5 ? 1 : -1 });
      opts.push({ axis: 'z', dir: Math.random() < 0.5 ? 1 : -1 });
      const pick = opts[Math.floor(Math.random() * opts.length)];
      r.axis = pick.axis; r.dir = pick.dir;
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
    r.heading = r.axis === 'z' ? (r.dir > 0 ? Math.PI : 0) : (r.dir > 0 ? -Math.PI / 2 : Math.PI / 2);
    r.mesh.position.set(r.x, 0, r.z);
    r.mesh.rotation.y = r.heading;
    for (const w of r.mesh.userData.wheels) w.rotation.x += r.speed * dt * 2.2;
    if (r.stopped) r.mesh.userData.setDamage(1);
  }
}
