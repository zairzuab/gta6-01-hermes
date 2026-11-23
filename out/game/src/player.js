// Player: Marlow Reyes on foot and behind the wheel.
// Car physics are arcade — accelerate, brake, steer with speed-scaled
// authority, handbrake slides — plus collision response against building
// footprints, the sea and traffic. On foot the walker is camera-relative with
// a sprint stamina budget and a jump.
import * as THREE from 'three';
import { makeCar, makePerson } from './vehicles.js';
import { clamp, damp, disposeGroup } from './util.js';

const WALK_SPEED = 6.2;
const SPRINT_MULT = 1.65;
const JUMP_VY = 7.4;
const GRAVITY = 20;

export class Player {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.x = 30; this.z = 96;
    this.heading = Math.PI;         // 0 = +z; a car's nose is local -z
    this.speed = 0;                 // m/s, signed (negative = reversing)
    this.inCar = false;
    this.onFoot = true;
    this.car = null;
    this.carName = 'BRISA GT';
    this.topSpeed = 42;
    this.enginePct = 96;
    this.health = 100;
    this.armour = 40;
    this.stamina = 100;
    this.jumpY = 0;
    this.jumpVY = 0;
    this.grounded = true;
    this.tiresPopped = false;
    this.collisionCooldown = 0;
    this.camYaw = Math.PI;
    this.camPitch = 0.32;
    this.camOrbit = 0;              // mouse look-around while driving
    this.walkPhase = 0;
    this.meleeCooldown = 0;
    this.meleeSwing = 0;
    this.crashShake = 0;
    this.groundY = 0;
    this.stepAcc = 0;               // distance walked since the last footstep
    this.events = [];              // {type:'step'|'jump'|'land', ...} drained by the game
    this.limit = city.worldLimit();

    this.body = makePerson(0x2ea88a, 0x2a3a55);
    this.body.position.set(this.x, 0, this.z);
    scene.add(this.body);
  }

  /** Park the hero car and step straight into it (the start of a job). */
  spawnCar(x, z, heading) {
    if (this.car) { this.scene.remove(this.car); disposeGroup(this.car); }
    const car = makeCar('player');
    car.position.set(x, 0, z);
    car.rotation.y = heading;
    this.scene.add(car);
    this.car = car;
    this.carName = car.userData.name;
    this.topSpeed = car.userData.topSpeed;
    this.x = x; this.z = z; this.heading = heading;
    this.enterCar();
    return car;
  }

  /** Get into a car: either the one given or the one already under us. */
  enterCar(mesh = null) {
    if (mesh) {
      this.car = mesh;
      // A stolen ride must report its own name and pace: without this the
      // speedometer kept the last car's name after a car-jack.
      if (mesh.userData) {
        this.carName = mesh.userData.name || 'STOLEN RIDE';
        if (mesh.userData.topSpeed) this.topSpeed = mesh.userData.topSpeed;
      }
    }
    if (!this.car) return false;
    this.inCar = true;
    this.onFoot = false;
    this.body.visible = false;
    this.grounded = true;
    this.jumpY = 0;
    this.jumpVY = 0;
    this.x = this.car.position.x;
    this.z = this.car.position.z;
    this.heading = this.car.rotation.y;
    this.speed = 0;
    this.handbrakeSlide = false;
    this.camOrbit = 0;
    // A fresh ride must not inherit the last one's camera kick, swing or
    // stride: those belong to the body that just got out.
    this.crashShake = 0;
    this.meleeSwing = 0;
    this.stepAcc = 0;
    return true;
  }

  /** Step out on the driver's side, moved aside if that spot is blocked. */
  exitCar() {
    if (!this.car) return;
    const cands = [];
    // The driver's door is the left side of the car (local -x), which in world
    // space is +cos(heading) for heading 0; test it first so exiting parks the
    // walker on the pavement side, not the traffic side.
    for (const side of [1, -1]) {
      cands.push([this.x + Math.cos(this.heading) * side * 2.4, this.z - Math.sin(this.heading) * side * 2.4]);
    }
    cands.push([this.x, this.z + 2.6], [this.x, this.z - 2.6]);
    let sx = this.x, sz = this.z;
    for (const [cx, cz] of cands) {
      if (!this.city.hitsBuilding(cx, cz, 0.8) && !this.city.isWater(cx, cz)) { sx = cx; sz = cz; break; }
    }
    this.inCar = false;
    this.onFoot = true;
    this.body.visible = true;
    this.x = sx; this.z = sz;
    this.body.position.set(sx, this.city.groundHeightAt(sx, sz), sz);
    this.body.rotation.y = this.heading;
    this.speed = 0;
    this.handbrakeSlide = false;
    this.camYaw = this.heading;
    // Leave the car level where it was abandoned: the pitch and roll it wore
    // while being driven are not how a parked car should sit.
    this.car.rotation.x = 0;
    this.car.rotation.z = 0;
  }

  /** Take over a traffic car's mesh (a steal). Returns the group. */
  takeCar(mesh) {
    if (this.car && this.car !== mesh) { this.scene.remove(this.car); disposeGroup(this.car); }
    this.car = mesh;
    this.carName = mesh.userData.name || 'STOLEN RIDE';
    this.topSpeed = mesh.userData.topSpeed || 30;
    this.tiresPopped = false;
    this.enterCar();
    return mesh;
  }

  /** Leave the current car where it is and forget it (a mission hand-off). */
  abandonCar() {
    this.car = null;
  }

  damage(amount, cause = 'hit') {
    if (this.health <= 0) return true;
    if (this.armour > 0) {
      const absorbed = Math.min(this.armour, amount * 0.62);
      this.armour -= absorbed;
      amount -= absorbed;
    }
    this.health -= amount;
    this.crashShake = Math.min(1, this.crashShake + amount / 40);
    return this.health <= 0;
  }

  heal(n) { this.health = Math.min(100, this.health + n); }
  addArmour(n) { this.armour = Math.min(100, this.armour + n); }

  speedKmh() { return Math.abs(this.speed) * 3.6; }

  update(dt, input, traffic) {
    this.collisionCooldown -= dt;
    this.meleeCooldown -= dt;
    if (this.meleeSwing > 0) this.meleeSwing -= dt * 3.2;
    this.crashShake = Math.max(0, this.crashShake - dt * 1.6);
    // A car that has been fully wrecked cannot be driven any further: the
    // engine dies, the wheels lock, and the ride is left where it stopped.
    // The player can still get out and run, so a dead car is a setback rather
    // than a soft-lock.
    if (this.inCar && this.enginePct <= 20.5 && Math.abs(this.speed) > 0.01) {
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 30 * dt);
    }
    if (this.inCar) return this.updateDriving(dt, input, traffic);
    return this.updateWalking(dt, input);
  }

  /** Is there room to stand at (x,z)? Used by the enter/exit logic. */
  canStand(x, z) {
    return !this.city.hitsBuilding(x, z, 0.9) && !this.city.isWater(x, z);
  }

  /**
   * Push the walker out of a building footprint instead of refusing to move.
   * Without this, walking into a wall stops the character dead, which reads as
   * the controls breaking rather than as a collision.
   */
  slide(nx, nz) {
    if (this.canStand(nx, nz)) { this.x = nx; this.z = nz; return; }
    if (this.canStand(nx, this.z)) { this.x = nx; return; }
    if (this.canStand(this.x, nz)) { this.z = nz; return; }
    // Fully blocked: nudge out along the shallowest axis of the footprint.
    for (const c of this.city.colliders) {
      const dx = nx - c.x, dz = nz - c.z;
      const ox = c.halfX + 0.9 - Math.abs(dx);
      const oz = c.halfZ + 0.9 - Math.abs(dz);
      if (ox > 0 && oz > 0) {
        if (ox < oz) this.x = c.x + Math.sign(dx) * (c.halfX + 0.9);
        else this.z = c.z + Math.sign(dz) * (c.halfZ + 0.9);
        return;
      }
    }
  }

  // ---- driving -------------------------------------------------------------
  updateDriving(dt, input, traffic) {
    const engineFactor = this.tiresPopped ? 0.42 : 0.55 + 0.45 * (this.enginePct / 100);
    // A wrecked engine (20%) leaves just enough drive to coast out of traffic,
    // but never enough to outrun a cruiser — the player has to bail out.
    const maxSpeed = this.enginePct <= 20.5 ? 9 : this.topSpeed * engineFactor;
    const maxReverse = 13;
    const forward = input.down('KeyW') || input.down('ArrowUp');
    const back = input.down('KeyS') || input.down('ArrowDown');
    const handbrake = input.down('Space');

    const accel = 24 * (0.6 + 0.4 * (this.enginePct / 100));
    if (forward) this.speed += accel * dt;
    if (back) {
      if (this.speed > 0.5) this.speed -= 38 * dt;
      else this.speed -= accel * 0.62 * dt;
    }
    if (!forward && !back) {
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 9 * dt);
    }
    if (handbrake) this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 32 * dt);
    this.speed = clamp(this.speed, -maxReverse, maxSpeed);
    if (this.tiresPopped) this.speed *= 1 - 0.25 * dt;
    if (this.enginePct <= 20.5) this.speed *= 1 - 0.5 * dt;   // a dead engine coasts to a stop

    const steerInput = (input.down('KeyA') || input.down('ArrowLeft') ? 1 : 0)
      - (input.down('KeyD') || input.down('ArrowRight') ? 1 : 0);
    const steerAuthority = 1.75 * Math.min(1, Math.abs(this.speed) / 10 + 0.22) * (handbrake ? 1.75 : 1);
    const dirSign = this.speed >= 0 ? 1 : -1;
    this.heading += steerInput * steerAuthority * dirSign * dt * Math.min(1, Math.abs(this.speed) / 6 + 0.14);
    // A handbrake slide is a real slide: the car keeps its momentum while the
    // heading swings, which is what makes the handbrake useful.
    this.handbrakeSlide = !!(handbrake && Math.abs(this.speed) > 8 && steerInput !== 0);
    if (this.handbrakeSlide) this.speed *= 1 - 0.5 * dt;

    const nx = this.x - Math.sin(this.heading) * this.speed * dt;
    const nz = this.z - Math.cos(this.heading) * this.speed * dt;

    // Mouse look-around while driving; it recentres when the wheel is straight,
    // and it only turns the view while the pointer is actually captured, so a
    // stray mousemove over a menu button cannot spin the camera.
    if (input.looking) this.camOrbit -= input.mouseDX * 0.004;
    if (!input.mouseDown) this.camOrbit = damp(this.camOrbit, 0, 1.6, dt);

    const ev = { crashed: false, hard: false };

    // Buildings and the sea: slide along the wall, bleed speed, take a hit.
    const blocked = this.city.hitsBuilding(nx, nz, 1.6) || this.city.isWater(nx, nz);
    if (blocked) {
      const hitX = this.city.hitsBuilding(nx, this.z, 1.6) || this.city.isWater(nx, this.z);
      const hitZ = this.city.hitsBuilding(this.x, nz, 1.6) || this.city.isWater(this.x, nz);
      if (!hitX) this.x = nx;
      if (!hitZ) this.z = nz;
      if (Math.abs(this.speed) > 10 && this.collisionCooldown <= 0) {
        this.collisionCooldown = 0.6;
        // Read the impact speed before the crash bleeds it off: `ev.hard` was
        // computed after the 0.34 multiplier, so even a 40 m/s wall hit looked
        // like a gentle bump and never triggered the hard-crash response.
        const impact = Math.abs(this.speed);
        this.damage(impact * 0.55, 'crash');
        this.enginePct = clamp(this.enginePct - impact * 0.35, 20, 100);
        this.speed *= 0.34;
        ev.crashed = true;
        ev.hard = impact > 14;
      } else {
        this.speed *= 0.55;
      }
    } else {
      this.x = nx; this.z = nz;
    }

    // Traffic: bump, scare the driver, small damage.
    if (traffic) {
      for (const c of traffic.cars) {
        const d = Math.hypot(c.x - this.x, c.z - this.z);
        if (d < 3.6 && Math.abs(this.speed) > 4) {
          c.scared = 2.5;
          // Shove the other car out of the way so the pile-up resolves.
          const push = (3.6 - d) * 0.5;
          const ux = (c.x - this.x) / (d || 1), uz = (c.z - this.z) / (d || 1);
          c.x += ux * push; c.z += uz * push;
          c.mesh.position.set(c.x, 0, c.z);
          if (this.collisionCooldown <= 0) {
            this.collisionCooldown = 0.5;
            this.damage(4, 'traffic');
            this.enginePct = clamp(this.enginePct - 2.5, 20, 100);
            this.speed *= 0.58;
            ev.crashed = true;
          }
        }
      }
    }

    this.limit = this.city.worldLimit();
    this.x = clamp(this.x, this.limit.minX, this.limit.maxX);
    this.z = clamp(this.z, this.limit.minZ, this.limit.maxZ);

    const gh = this.city.groundHeightAt(this.x, this.z);
    this.groundY = gh;
    this.car.position.set(this.x, gh, this.z);
    this.car.rotation.y = this.heading;
    this.car.rotation.z = -steerInput * 0.3 * Math.min(1, Math.abs(this.speed) / 20);
    this.car.rotation.x = clamp(-this.speed * 0.004, -0.05, 0.05);
    for (const w of this.car.userData.wheels) w.rotation.x += this.speed * dt * 2.2;
    if (this.car.userData.setSteer) this.car.userData.setSteer(steerInput);
    // Engine wear from hard driving; it recovers slowly when driven gently.
    this.enginePct = clamp(this.enginePct + (Math.abs(this.speed) > this.topSpeed * 0.8 ? -0.9 : 0.35) * dt, 20, 100);
    return ev;
  }

  // ---- walking -------------------------------------------------------------
  updateWalking(dt, input) {
    if (input.looking) {
      this.camYaw -= input.mouseDX * 0.0042;
      this.camPitch = clamp(this.camPitch + input.mouseDY * 0.0032, -0.15, 1.05);
    }
    if (input.down('ArrowLeft')) this.camYaw += 2.0 * dt;
    if (input.down('ArrowRight')) this.camYaw -= 2.0 * dt;

    const f = (input.down('KeyW') || input.down('ArrowUp') ? 1 : 0)
      - (input.down('KeyS') || input.down('ArrowDown') ? 1 : 0);
    const r = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const moving = f !== 0 || r !== 0;
    const wantSprint = input.down('ShiftLeft') || input.down('ShiftRight');
    const sprinting = wantSprint && moving && this.stamina > 1;
    const sp = WALK_SPEED * (sprinting ? SPRINT_MULT : 1);

    if (moving) {
      const len = Math.hypot(f, r) || 1;
      // Forward is (-sin yaw, -cos yaw); right is (cos yaw, -sin yaw).
      const mx = (-Math.sin(this.camYaw) * f + Math.cos(this.camYaw) * r) / len;
      const mz = (-Math.cos(this.camYaw) * f - Math.sin(this.camYaw) * r) / len;
      const nx = this.x + mx * sp * dt;
      const nz = this.z + mz * sp * dt;
      this.slide(nx, nz);
      this.heading = Math.atan2(-mx, -mz);
      this.walkPhase += sp * dt * 2.1;
      // Footsteps are distance-based, so the cadence matches the stride.
      if (this.grounded) {
        this.stepAcc += sp * dt;
        const stride = sprinting ? 2.5 : 2.0;
        if (this.stepAcc >= stride) {
          this.stepAcc = 0;
          this.events.push({ type: 'step', sprint: sprinting });
        }
      }
    }

    // Stamina: sprint drains, otherwise it recovers.
    if (sprinting) this.stamina = Math.max(0, this.stamina - 16 * dt);
    else this.stamina = Math.min(100, this.stamina + (moving ? 7 : 14) * dt);

    // Jump and gravity.
    if (this.grounded && input.pressed('Space')) {
      this.jumpVY = JUMP_VY;
      this.grounded = false;
      this.events.push({ type: 'jump' });
    }
    if (!this.grounded) {
      this.jumpVY -= GRAVITY * dt;
      this.jumpY += this.jumpVY * dt;
      if (this.jumpY <= 0) {
        const impact = Math.abs(this.jumpVY) / JUMP_VY;
        this.jumpY = 0; this.jumpVY = 0; this.grounded = true;
        // A landing hard enough to matter makes a sound and a small camera dip.
        this.events.push({ type: 'land', strength: clamp(impact, 0.3, 1) });
      }
    }

    this.groundY = this.city.groundHeightAt(this.x, this.z);
    this.body.position.set(this.x, this.groundY + this.jumpY, this.z);
    this.body.rotation.y = this.heading;
    const swing = moving ? Math.sin(this.walkPhase) * 0.55 : 0;
    this.body.userData.legs[0].rotation.x = swing;
    this.body.userData.legs[1].rotation.x = -swing;
    this.body.userData.arms[0].rotation.x = -swing * 0.72 - this.meleeSwing * 1.4;
    this.body.userData.arms[1].rotation.x = swing * 0.72 + this.meleeSwing * 1.4;

    this.limit = this.city.worldLimit();
    this.x = clamp(this.x, this.limit.minX, this.limit.maxX);
    this.z = clamp(this.z, this.limit.minZ, this.limit.maxZ);
    return null;
  }
}
