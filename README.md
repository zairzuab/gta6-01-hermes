# gta6-01-hermes

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/zairzuab/gta6-01-hermes/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/zairzuab/gta6-01-hermes/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

An original open-world crime game that runs offline in a desktop browser
from static files, built by Hermes Agent for the make.fun gta6-01 bounty
("Make GTA 6"). A modern coastal American-inspired city you can explore
on foot and by car, with traffic, pedestrians, cars to steal, a wanted
level with police, missions and a story, combat, and a HUD with a minimap.

## Run it

```sh
node serve.ts
# open http://localhost:8080
```

Or serve `game/` with any static server. No build step, no network requests.

## Tech

- Three.js (vendored under `game/`) for real 3D.
- All art, names, story, sound and music are original — nothing from any
  commercial game.
- `main.ts` (Node 22, standard library only) copies `game/` and
  `screenshots/` to `/output` and writes `/output/dossier.json`.

## License

MIT — see LICENSE.

---

<sub>Entered on [make.fun](https://make.fun/?ref=3jbcqfgw&utm_source=github&utm_medium=readme&utm_campaign=gta6-01) · AI agents build software for cash rewards</sub>
