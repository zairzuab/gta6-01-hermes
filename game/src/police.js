// Police: the wanted system and the Port Azul PD response.
// Wanted is 0-5 stars driven by a heat meter. Cruisers chase and PIT; at 2+
// stars a roadblock with a spike strip is placed ahead; at 3+ a helicopter
// orbits with a searchlight; at 5 an armoured truck rolls in. Heat decays
// only when the player is out of sight and slow — losing the heat is the
// way a mission is won.
import * as THREE from 'three';
import { makeCar, makeHelicopter, makeTank } from './vehicles.js';
import { CITY_HALF, PITCH, nearestStreet } from './city.js';
import { clamp, disposeGroup } from './util.js';

const CALLSIGNS = ['HALCON-1', 'LIMA-13', 'LIMA-21', 'BRAVO-6', 'LIMA-24', 'HALCON-2', 'BRAVO-9', 'LIMA-31'];

export class Police {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.wanted = 0;
    this.heat = 0;              // 0..100, drives the star count
    this.hiddenTimer = 0;
    this.cruisers = [];         // {mesh, x, z, heading, speed, state, callsign, hp, disabled}
    this.heli = null;
    this.tank = null;
    this.roadblock = null;
    this.spawnTimer = 0;
    this.roadblockTimer = 8;
    this.lightPhase = 0;
    this.lastKnown = { x: 0, z: 0 };
    this.fireTimer = 4;
    this.arrest = 0;           // 0..1, fills while an officer has you boxed in
    this.shots = [];           // tracer lines fired by officers
    this.onShoot = null;       // (damage) => void, set by the game
    this.onRam = null;         // (damage) => void, set by the game
  }

  stars() { return this.wanted; }

  /** Record a crime: heat, and the last place the player was seen. */
  crime(n, reason, px = null, pz = null) {
    if (px !== null) this.lastKnown.x = px;
    if (pz !== null) this.lastKnown.z = pz;
    return this.addHeat(n, reason);
  }

  /** Add heat; returns {raised, to, reason} when the star count climbs. */
  addHeat(n, reason) {
    this.heat = Math.min(100, this.heat + n);
    this.hiddenTimer = 0;
    const want = this.starsForHeat(this.heat);
    if (want > this.wanted) {
      this.wanted = want;
      return { raised: true, to: want, reason };
    }
    return { raised: false, to: this.wanted, reason };
  }

  starsForHeat(heat) {
    return heat <= 0 ? 0 : heat < 20 ? 1 : heat < 40 ? 2 : heat < 60 ? 3 : heat < 85 ? 4 : 5;
  }

  clearHeat() {
    this.heat = 0;
    this.wanted = 0;
    this.hiddenTimer = 0;
  }

  /** A street point at least `minDist` from the player, for spawning units. */
  spawnPoint(playerX, playerZ, minDist = 70) {
    // Keep the spawn under the 190 m break-off radius: a unit placed past it
    // is removed again in the same update, so a pursuit could go a whole
    // spawn cycle (or several) with no cruiser on the road at all.
    for (let tries = 0; tries < 14; tries++) {
      const i = 1 + Math.floor(Math.random() * 6);
      const j = 1 + Math.floor(Math.random() * 6);
      const x = -CITY_HALF + i * PITCH;
      const z = -CITY_HALF + j * PITCH;
      const d = Math.hypot(x - playerX, z - playerZ);
      if (d > minDist && d < 175) return { x, z };
    }
    return { x: playerX + 90, z: playerZ };
  }

  spawnCruiser(px, pz, at = null) {
    const p = at || this.spawnPoint(px, pz);
    const mesh = makeCar('police');
    mesh.position.set(p.x, 0, p.z);
    this.scene.add(mesh);
    this.city.addHeadlights?.(mesh);
    const c = {
      mesh, x: p.x, z: p.z,
      heading: Math.atan2(-(px - p.x), -(pz - p.z)),
      speed: 0, state: 'chase',
      callsign: CALLSIGNS[this.cruisers.length % CALLSIGNS.length],
      pitTimer: 0, ramCooldown: 0, hp: 100, disabled: false,
    };
    this.cruisers.push(c);
    return c;
  }

  spawnHelicopter(px, pz) {
    if (this.heli) return;
    const mesh = makeHelicopter();
    mesh.scale.setScalar(1.3);
    mesh.position.set(px, 18, pz + 38);
    this.scene.add(mesh);
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(7.5, 24),
      new THREE.MeshBasicMaterial({
        color: 0xfff2b0, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(px, 0.06, pz + 42);
    this.scene.add(pool);
    this.heli = { mesh, angle: Math.PI / 2, height: 18, pool };
  }

  spawnTank(px, pz, at = null) {
    if (this.tank) return;
    const mesh = makeTank();
    const p = at || this.spawnPoint(px, pz);
    mesh.position.set(p.x, 0, p.z);
    this.scene.add(mesh);
    this.tank = { mesh, x: p.x, z: p.z, heading: 0, speed: 0, dist: 0 };
  }

  removeHelicopter() {
    if (!this.heli) return;
    this.scene.remove(this.heli.mesh);
    disposeGroup(this.heli.mesh);
    if (this.heli.pool) { this.scene.remove(this.heli.pool); disposeGroup(this.heli.pool); }
    this.heli = null;
  }

  removeTank() {
    if (!this.tank) return;
    this.scene.remove(this.tank.mesh);
    disposeGroup(this.tank.mesh);
    this.tank = null;
  }

  clearRoadblock() {
    if (!this.roadblock) return;
    for (const m of this.roadblock.meshes) { this.scene.remove(m); disposeGroup(m); }
    this.roadblock = null;
  }

  /** Two cruisers across the street ahead of the player plus a spike strip. */
  placeRoadblock(px, pz, heading) {
    this.clearRoadblock();
    // The roadblock is set across the street the player is actually on: a
    // fixed 58 m ahead can land in a building or over the water, where it can
    // never be driven into. Snap to the nearest street centreline first.
    const nsX = nearestStreet(px);
    const nsZ = nearestStreet(pz);
    const onNS = nsX !== null && (nsZ === null || Math.abs(px - nsX) < Math.abs(pz - nsZ));
    const bx = onNS ? nsX : px + Math.sin(heading) * 58;
    const bz = onNS ? pz + Math.cos(heading) * 58 : (nsZ ?? pz);
    const along = Math.hypot(bx - px, bz - pz);
    // Too close to be worth blocking: leave the strip for later.
    if (along < 30) return;
    const meshes = [];
    const perp = onNS ? Math.PI / 2 : heading + Math.PI / 2;
    for (const s of [-4.6, 4.6]) {
      const car = makeCar('police');
      car.position.set(bx + Math.sin(perp) * s, 0, bz + Math.cos(perp) * s);
      car.rotation.y = perp;
      this.scene.add(car);
      this.city.addHeadlights?.(car);
      meshes.push(car);
    }
    const strip = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.12, 1.2),
      new THREE.MeshLambertMaterial({ color: 0x222222 }));
    strip.add(base);
    for (let i = -4; i <= 4; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.55, 4),
        new THREE.MeshLambertMaterial({ color: 0xcccccc }));
      spike.position.set(i, 0.32, 0);
      strip.add(spike);
    }
    strip.position.set(bx, 0.1, bz);
    strip.rotation.y = perp;
    this.scene.add(strip);
    meshes.push(strip);
    this.roadblock = { meshes, x: bx, z: bz, heading: perp, active: true, strip };
  }

  /** True when the player has driven over the spike strip. */
  checkSpikes(x, z) {
    if (!this.roadblock || !this.roadblock.active) return false;
    if (Math.hypot(x - this.roadblock.x, z - this.roadblock.z) < 5.5) {
      this.roadblock.active = false;
      return true;
    }
    return false;
  }

  update(dt, player, onFoot) {
    const px = player.x, pz = player.z;
    const pSpeed = Math.abs(player.speed || 0);
    this.lightPhase += dt;

    // --- heat decay while unseen ------------------------------------------
    // Anything that can see the player — a cruiser, the armoured truck, the
    // helicopter's searchlight — pins the heat. Being far away is not enough:
    // at 3+ stars the air unit tracks you, so "out of sight" has to mean no
    // unit at all, which is what makes breaking contact the escape mechanic.
    const nearest = this.nearestPoliceDist(px, pz);
    const air = this.heli;
    const airWatching = air && Math.hypot(air.mesh.position.x - px, air.mesh.position.z - pz) < 120;
    const inSight = nearest < 55 || airWatching;
    if (nearest < 70) { this.lastKnown.x = px; this.lastKnown.z = pz; }
    if (this.wanted > 0 && !inSight && pSpeed < 12) {
      this.hiddenTimer += dt;
      if (this.hiddenTimer > 6) {
        this.heat = Math.max(0, this.heat - dt * 9);
        const want = this.starsForHeat(this.heat);
        if (want < this.wanted) this.wanted = want;
      }
    } else {
      this.hiddenTimer = 0;
    }
    // Units only exist while they are wanted; with the heat gone they are gone
    // too, so a cleared trail stays clear instead of quietly rebuilding.
    if (this.wanted === 0 && (this.cruisers.length || this.heli || this.tank || this.roadblock)) {
      for (const c of this.cruisers) { this.scene.remove(c.mesh); disposeGroup(c.mesh); }
      this.cruisers = [];
      this.removeHelicopter();
      this.removeTank();
      this.clearRoadblock();
      this.arrest = 0;
    }

    // --- spawn / despawn by wanted level ----------------------------------
    const wantCruisers = this.wanted === 0 ? 0 : Math.min(2 + this.wanted, 6);
    this.spawnTimer -= dt;
    if (this.cruisers.length < wantCruisers && this.spawnTimer <= 0) {
      this.spawnCruiser(px, pz);
      this.spawnTimer = 2.5;
    }
    // Cruisers that fall far behind break off, so a player who actually gets
    // away is not trailed forever by a car that can never catch up.
    for (let i = this.cruisers.length - 1; i >= 0; i--) {
      const c = this.cruisers[i];
      if (!c.disabled && Math.hypot(c.x - px, c.z - pz) > 190) {
        this.scene.remove(c.mesh);
        disposeGroup(c.mesh);
        this.cruisers.splice(i, 1);
      }
    }
    if (this.wanted === 0) {
      for (const c of this.cruisers) { this.scene.remove(c.mesh); disposeGroup(c.mesh); }
      this.cruisers = [];
      this.removeHelicopter();
      this.removeTank();
      this.clearRoadblock();
    }
    if (this.wanted >= 3) this.spawnHelicopter(px, pz); else this.removeHelicopter();
    if (this.wanted >= 5) this.spawnTank(px, pz); else this.removeTank();

    // --- roadblocks at 2+ stars -------------------------------------------
    this.roadblockTimer -= dt;
    if (this.wanted >= 2 && this.roadblockTimer <= 0 && !this.roadblock) {
      this.placeRoadblock(px, pz, player.heading);
      this.roadblockTimer = 16;
    }
    if (this.roadblock && Math.hypot(px - this.roadblock.x, pz - this.roadblock.z) > 130) {
      this.clearRoadblock();
      this.roadblockTimer = 6;
    }

    // --- cruiser AI: chase, PIT, box in -----------------------------------
    for (const c of this.cruisers) {
      if (c.disabled) continue;
      // Far from the player they search the last known position and sweep
      // around it, which is what makes breaking line of sight work.
      const searching = Math.hypot(px - c.x, pz - c.z) > 85;
      const tx = searching ? this.lastKnown.x + Math.sin(this.lightPhase * 0.6 + c.pitTimer * 10) * 18 : px;
      const tz = searching ? this.lastKnown.z + Math.cos(this.lightPhase * 0.5 + c.pitTimer * 10) * 18 : pz;
      const dx = tx - c.x, dz = tz - c.z;
      const dist = Math.hypot(px - c.x, pz - c.z);
      const targetHeading = Math.atan2(-dx, -dz);
      let turn = targetHeading - c.heading;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;

      if (dist < 9 && Math.abs(turn) < 0.5 && pSpeed > 8 && c.ramCooldown <= 0) {
        c.state = 'pit';
        c.pitTimer = 0.9;
        c.ramCooldown = 4;
      }
      if (c.state === 'pit') {
        c.pitTimer -= dt;
        turn += (dx > 0 ? 1 : -1) * 0.62;
        if (c.pitTimer <= 0) c.state = 'chase';
      }
      c.ramCooldown -= dt;

      const topSpeed = c.state === 'pit' ? 46 : 38;
      // Match the player's speed when close so a pursuit does not fall behind
      // on a straight, but never exceed the cruiser's own limit.
      const close = dist < 22 ? Math.max(pSpeed * 1.05, 16) : topSpeed;
      const wantSpeed = dist > 60 ? topSpeed : Math.min(close, 18 + dist * 0.45);
      c.speed += (wantSpeed - c.speed) * Math.min(1, dt * 1.2);
      c.heading += clamp(turn, -1.9 * dt, 1.9 * dt);
      c.x -= Math.sin(c.heading) * c.speed * dt;
      c.z -= Math.cos(c.heading) * c.speed * dt;
      // Ram damage: a hard PIT damages the player's car, a soft nudge does not.
      if (dist < 3.6 && Math.abs(c.speed) > 6 && c.ramCooldown <= 0) {
        c.ramCooldown = 0.7;
        if (this.onRam) this.onRam(Math.abs(c.speed) * 0.4);
      }
      if (this.city.hitsBuilding(c.x, c.z, 1.5) || this.city.isWater(c.x, c.z)) {
        c.x += Math.sin(c.heading) * c.speed * dt;
        c.z += Math.cos(c.heading) * c.speed * dt;
        c.heading += 3.6 * dt;
      }
      c.mesh.position.set(c.x, 0, c.z);
      c.mesh.rotation.y = c.heading;
      for (const w of c.mesh.userData.wheels) w.rotation.x += c.speed * dt * 2.2;
      const lb = c.mesh.userData.lightBar;
      if (lb) {
        const on = Math.floor(this.lightPhase * 6) % 2 === 0;
        lb.userData.red.material.emissiveIntensity = on ? 2.6 : 0.2;
        lb.userData.blue.material.emissiveIntensity = on ? 0.2 : 2.6;
      }
      c.dist = dist;
    }

    // --- helicopter: a low close orbit with a searchlight ------------------
    if (this.heli) {
      const h = this.heli;
      h.angle += dt * 0.34;
      const r = 38;
      h.mesh.position.set(
        px + Math.cos(h.angle) * r,
        h.height + Math.sin(h.angle * 0.7) * 3.2,
        pz + Math.sin(h.angle) * r);
      h.mesh.rotation.y = Math.atan2(px - h.mesh.position.x, pz - h.mesh.position.z);
      h.mesh.userData.rotor.rotation.y += dt * 22;
      h.mesh.userData.tailRotor.rotation.x += dt * 18;
      const bc = h.mesh.userData.beacon;
      if (bc) bc.material.emissiveIntensity = (Math.floor(this.lightPhase * 3) % 2 === 0) ? 3 : 0.25;
      if (h.pool) h.pool.position.set(h.mesh.position.x, 0.06, h.mesh.position.z);
    }

    // --- armoured truck: slow, heavy, rams --------------------------------
    if (this.tank) {
      const t = this.tank;
      const dx = px - t.x, dz = pz - t.z;
      const dist = Math.hypot(dx, dz);
      const targetHeading = Math.atan2(-dx, -dz);
      let turn = targetHeading - t.heading;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      t.heading += clamp(turn, -0.7 * dt, 0.7 * dt);
      t.speed += (Math.min(11, dist * 0.3) - t.speed) * Math.min(1, dt);
      t.x -= Math.sin(t.heading) * t.speed * dt;
      t.z -= Math.cos(t.heading) * t.speed * dt;
      t.mesh.position.set(t.x, 0, t.z);
      t.mesh.rotation.y = t.heading;
      t.dist = dist;
      t.mesh.userData.turret.rotation.y = clamp(Math.atan2(-dx, -dz) - t.heading, -0.9, 0.9);
    }

    // --- officer gunfire at 3+ stars --------------------------------------
    this.fireTimer -= dt;
    if (this.wanted >= 3 && this.fireTimer <= 0) {
      this.fireTimer = 1.1 + Math.random() * 1.5;
      const shooter = this.cruisers.find((c) => !c.disabled && Math.hypot(c.x - px, c.z - pz) < 48);
      if (shooter) {
        const hit = Math.random() < (onFoot ? 0.5 : 0.28);
        this._tracer(shooter.x, shooter.z, px, pz, hit);
        if (hit && this.onShoot) this.onShoot(3 + Math.random() * 5);
      } else if (this.wanted >= 4 && this.heli
        && Math.hypot(this.heli.mesh.position.x - px, this.heli.mesh.position.z - pz) < 95) {
        // At four stars the air unit takes the shots no cruiser can reach.
        const hit = Math.random() < (onFoot ? 0.22 : 0.13);
        this._tracer(this.heli.mesh.position.x, this.heli.mesh.position.z, px, pz, hit);
        if (hit && this.onShoot) this.onShoot(2 + Math.random() * 4);
      }
    }

    // --- arrest: an officer has you boxed in and you are not moving --------
    const near = this.nearestPoliceDist(px, pz);
    if (this.wanted > 0 && onFoot && pSpeed < 1.2 && near < 7) this.arrest = Math.min(1, this.arrest + dt / 3);
    else this.arrest = Math.max(0, this.arrest - dt / 2);

    // --- officer tracers ---------------------------------------------------
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.scene.remove(s.line);
        s.line.geometry.dispose();
        s.line.material.dispose();
        this.shots.splice(i, 1);
      }
    }
  }

  /** A tracer from a cruiser toward the player; `hit` decides the endpoint. */
  _tracer(sx, sz, px, pz, hit) {
    const from = new THREE.Vector3(sx, 1.5, sz);
    const to = new THREE.Vector3(
      px + (hit ? 0 : (Math.random() - 0.5) * 7), 1.1,
      pz + (hit ? 0 : (Math.random() - 0.5) * 7));
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.shots.push({ line, life: 0.12 });
  }

  /** True when the player is close enough to be rammed by an armoured truck. */
  tankContact(px, pz) {
    if (!this.tank) return false;
    return Math.hypot(this.tank.x - px, this.tank.z - pz) < 4.2;
  }

  /** Shoot a cruiser; at zero it stalls and is out of the pursuit. */
  damageCruiser(c, dmg) {
    if (c.disabled) return false;
    c.hp -= dmg;
    if (c.hp <= 0) {
      c.disabled = true;
      c.speed = 0;
      c.state = 'disabled';
      c.mesh.userData.setDamage(1);
      return true;
    }
    c.mesh.userData.setDamage(1 - c.hp / 100);
    return false;
  }

  /** Wipe every unit: a restart or a new game. */
  reset() {
    for (const c of this.cruisers) { this.scene.remove(c.mesh); disposeGroup(c.mesh); }
    this.cruisers = [];
    this.removeHelicopter();
    this.removeTank();
    this.clearRoadblock();
    for (const s of this.shots) this.scene.remove(s.line);
    this.shots = [];
    this.heat = 0;
    this.wanted = 0;
    this.arrest = 0;
    this.lastKnown = { x: 0, z: 0 };
    // A stale hidden timer would let a brand-new pursuit start decaying heat
    // immediately; the light phase only drives the beacon flash, but reset it
    // so the next pursuit starts from a clean slate.
    this.hiddenTimer = 0;
    this.lightPhase = 0;
    // Restart the spawn and roadblock clocks too: carrying them over made a
    // fresh pursuit wait out a stale timer before its first cruiser, and could
    // drop a roadblock on the street the instant a new star count appeared.
    this.spawnTimer = 0;
    this.roadblockTimer = 8;
    this.fireTimer = 4;
  }

  nearestPoliceDist(px, pz) {
    let d = Infinity;
    for (const c of this.cruisers) d = Math.min(d, Math.hypot(c.x - px, c.z - pz));
    if (this.tank) d = Math.min(d, Math.hypot(this.tank.x - px, this.tank.z - pz));
    return d;
  }

  /** The HUD dispatch list: callsign, type, distance, status. */
  dispatchList(px, pz) {
    const list = [];
    for (const c of this.cruisers) {
      list.push({
        call: c.callsign, kind: 'CRUISER',
        dist: Math.round(Math.hypot(c.x - px, c.z - pz)),
        status: c.state === 'pit' ? 'PIT' : (c.dist < 12 ? 'BOX IN' : 'PURSUIT'),
        cls: c.state === 'pit' ? 'pit' : (c.dist < 12 ? 'box' : 'pursuit'),
      });
    }
    if (this.heli) list.push({ call: 'HALCON-1', kind: 'AIR', dist: 38, status: 'OVERHEAD', cls: 'air' });
    if (this.tank) list.push({ call: 'BRAVO-6', kind: 'ARMOURED', dist: Math.round(this.tank.dist || 0), status: 'PURSUIT', cls: 'pursuit' });
    if (this.roadblock) list.push({
      call: 'ROADBLOCK', kind: 'SPIKE STRIP',
      dist: Math.round(Math.hypot(this.roadblock.x - px, this.roadblock.z - pz)),
      status: 'AHEAD', cls: 'box',
    });
    return list.slice(0, 5);
  }
}
