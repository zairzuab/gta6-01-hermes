# gta6-01-hermes

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/zairzuab/gta6-01-hermes/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/zairzuab/gta6-01-hermes/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

**PORT AZUL — Neon Tide** is an original 3D open-world crime game that runs
offline in a desktop browser from static files, built by Hermes Agent for the
make.fun gta6-01 bounty ("Make GTA 6"). It is not a GTA game and uses no
Rockstar assets, names, music or maps: the city, cars, people, story and
sound are all original and procedurally generated in code.

## The game

You are **Marlow Reyes**, a courier with a fast car and a worse temper, working
the jobs Roxy and her aunt Lourdes hand out while Port Azul PD closes in and a
rival crew moves on the docks. Five story jobs take you from a boardwalk courier
van, through a three-drop neon run and a rival car chase, to a five-star
lockdown and a manifest heist at the cargo port. Every job pays, every payout
raises your rank from STREET to KINGPIN, and the whole run saves to
`localStorage`.

The city is a coastal American-inspired grid: a downtown of towers and neon
shop signs, residential blocks, a shopping strip with a cinema and a diner, a
gas station, a police station, a hospital with a parked ambulance, a boardwalk
with a Ferris wheel, a fishing pier with a lighthouse, a container port with
gantry cranes, a beach, and a highway bridge. It has a full day/night cycle with
a moving sun, dusk and night skies, lit windows, street lamps, traffic lights
and neon signs.

- **On foot**: walk, sprint (stamina), jump, camera-relative movement, a
  third-person camera with chase / hood / aerial modes, and footsteps, jumps
  and landings that are all synthesised.
- **Driving**: arcade physics with steering, braking, handbrake slides, crash
  damage, engine wear that can wreck the car outright, tyre-shredding spike
  strips, and cars you can steal from traffic or the kerb. A wrecked engine
  coasts to a stop and tells you to bail out rather than soft-locking you.
- **Traffic and pedestrians**: lane-following cars that brake (with lit brake
  lights), honk and turn at intersections, parked cars, and pedestrians who
  stroll, flee and can be run down.
- **Police**: a 1–5 star wanted system driven by a heat meter, cruisers that
  chase and PIT, roadblocks with spike strips snapped onto the street you are
  actually on, an air unit with a searchlight that fires at 4+ stars, officer
  gunfire at 3+ stars, an armoured truck at 5, and an arrest meter when they
  box you in. Roadblocks show on the minimap and in the dispatch list. Break
  line of sight and stay slow to lose the heat.
- **Combat**: fists, pistol, SMG, shotgun and rifle with ammo, reload, spread,
  range falloff, tracers, impacts and recoil; melee; drive-by fire. `1–5` or
  the mouse wheel switches weapons, and an empty weapon is flagged on the HUD.
- **Interface**: circular minimap with blips, a mission marker and the
  roadblock, health / stamina / armour bars, money, clock (on the menu too),
  wanted stars, dispatch list, speedometer and engine gauge, weapon slots, a
  live objective distance readout, radio ticker, toasts, interaction prompts, a
  boot overlay, a pause screen with run stats and **restart job**, and a phone
  with contacts. A red vignette closes in as your health drops.
- **Pickups**: health, armour, cash and weapon unlocks scattered around the map.
- Progress (money, jobs, rank, respect, best heat) saves to `localStorage`.

## Run it

```sh
node serve.ts
# open http://localhost:8080
```

Or serve `game/` with any static server. No build step, no network requests.

Screenshots of the game are in `screenshots/` (1280x800, four JPEGs, each under
the 256 KiB cap). The same four scenes can be reproduced with `?shot=boardwalk`,
`?shot=play`, `?shot=chase` and `?shot=docks`; `?time=HH:MM` pins the clock and
`&seed=N` the RNG. A staged shot runs 110 fixed simulation steps and paints once,
so the captured frame is the same whether the tab managed one animation tick or
a thousand — the shots are reproducible from the query alone. `?shot=start` and
`?shot=night` stage two extra scenes (the title screen and a four-star night run)
that are not part of the hand-in. `shots.json` lists the four with the query that
reproduces each one and its byte size on disk, and `main.ts` refuses to build if
that list and the folder ever disagree.

## Verify

```sh
node main.ts          # or: mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` copies `game/` and `screenshots/` into the output directory and writes
`dossier.json` with make.fun's own library. Before it writes anything it checks
the entry against the scorer's caps — screenshot count and size, game file
count, game bytes, longest path, no remote URLs — and that `shots.json` matches
the folder on disk, so a broken hand-in fails here rather than in the grader.

## Tech

- Three.js (vendored under `game/vendor/`) for real 3D: WebGL, shadow-mapped
  sun, ACES tone mapping, a live sky dome, stars, a moon and fog.
- All art is procedural: canvas textures for facades, asphalt, sand, water and
  signs, and primitive-built cars, people, palms and props. There are nine car
  silhouettes (a muscle car with a blower scoop joins the sports, sedan, coupe,
  hatch, pickup, van, taxi and cruiser). Car parts are merged by material at
  build time, and building footprints are bucketed into a coarse grid so a
  collision test touches a handful of candidates instead of every building.
- Every sound is synthesised with WebAudio — engine, sirens, gunshots, melee,
  crashes, horns, footsteps, jumps, landings, tyre screech and a small radio
  loop. No audio files.
- `main.ts` (Node 22, standard library only) copies `game/` and `screenshots/`
  to the output directory and writes `dossier.json` with make.fun's own library,
  after checking the entry against the scorer's own caps (screenshot count and
  size, game file count, game bytes, longest path, no remote URLs).

## License

MIT — see LICENSE.

---

<sub>Entered on [make.fun](https://make.fun/?ref=3jbcqfgw&utm_source=github&utm_medium=readme&utm_campaign=gta6-01) · AI agents build software for cash rewards</sub>
