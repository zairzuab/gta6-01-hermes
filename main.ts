// Entry point for the make.fun gta6-01 bounty ("Make GTA 6").
//
// The entry itself is the static game in ./game: index.html plus ES modules,
// with Three.js vendored under game/vendor so it runs offline with no network
// request and no build step. This program only hands that folder in: it copies
// game/ and screenshots/ to the output directory and writes dossier.json, the
// summary the judge reads, using make.fun's own library so the dossier matches
// what the scorer would write.
//
//   node serve.ts                              # play locally on :8080
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts   # build the entry
//
// Outside the grader's container MAKEFUN_OUTPUT_DIR stands in for /output.
//
// The hand-in is deliberately dumb about content: it refuses what the scorer
// would refuse (see CAPS) and reports what it copied. Everything the judge
// plays is in game/, and the checks below are what keep this honest — a
// missing vendored Three.js or an over-cap screenshot fails here rather than
// in the grader.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes the
// bytes; the others refuse an entry the scorer would refuse (more than 4
// screenshots or one over 256 KiB; more than 993 files under game/ or 48 MiB of
// game files; or a path under game/ over 1000 bytes).
const CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

// The entry must be self-contained: every module the page loads is local, and
// the two vendored Three.js files are what make that true.
const VENDOR_FILES = ['three.module.min.js', 'three.core.min.js'] as const;

// Refuse to hand in something that is not a playable entry, with the reason.
function assertPlayable() {
  const index = join(here, 'game', 'index.html');
  if (!existsSync(index)) throw new Error('game/index.html is missing: there is no page to play.');
  if (!existsSync(join(here, 'game', 'src', 'main.js'))) {
    throw new Error('game/src/main.js is missing: index.html would load a page with no script.');
  }
  // Three.js is vendored in two files (the module wrapper imports its core);
  // without both, the page boots into a blank canvas with no renderer.
  for (const rel of VENDOR_FILES) {
    const p = join(here, 'game', 'vendor', rel);
    if (!existsSync(p) || statSync(p).size < 100_000) {
      throw new Error(`game/vendor/${rel} is missing or truncated: the game would have no renderer.`);
    }
  }
  const shots = existsSync(join(here, 'screenshots'))
    ? readdirSync(join(here, 'screenshots')).filter((f) => /\.(png|jpe?g)$/i.test(f))
    : [];
  if (shots.length < 3) throw new Error(`screenshots/ holds ${shots.length} images; the entry needs 3 or 4.`);
  // An entry with more than the cap's screenshots is refused, not trimmed: the
  // extra files would be copied and the scorer would reject the whole entry.
  if (shots.length > CAPS.screenshots.max) {
    throw new Error(`screenshots/ holds ${shots.length} images; the cap is ${CAPS.screenshots.max}.`);
  }
  for (const name of shots) {
    const bytes = statSync(join(here, 'screenshots', name)).size;
    if (bytes > CAPS.screenshots.max_bytes) {
      throw new Error(`screenshots/${name} is ${bytes} bytes, over the ${CAPS.screenshots.max_bytes} cap.`);
    }
  }
  return shots;
}

// shots.json is the judge-facing list of what screenshots/ holds, and it is
// the only place the four ?shot= presets are documented. A stale entry — a
// file renamed on disk, a preset no longer listed, an extra image the dossier
// never mentions — is a broken entry, so check the list against the folder.
function assertShotsMatchDisk(names: string[]) {
  const file = join(here, 'shots.json');
  if (!existsSync(file)) {
    throw new Error('shots.json is missing: the dossier would describe screenshots that are not listed.');
  }
  let listed: { name?: unknown; query?: unknown }[];
  try {
    listed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`shots.json is not valid JSON: ${err}`);
  }
  if (!Array.isArray(listed)) throw new Error('shots.json must be a list of screenshot entries.');
  // A listed name is copied into the output as-is, so it must be a plain file
  // name: no path separators, no traversal, no duplicates.
  const seen = new Set();
  for (const entry of listed) {
    const n = entry?.name;
    if (typeof n !== 'string' || !/^[^/\\]+$/.test(n) || n === '.' || n === '..') {
      throw new Error(`shots.json entry ${String(n)} is not a plain file name.`);
    }
    if (seen.has(n)) throw new Error(`shots.json lists ${n} more than once.`);
    seen.add(n);
  }
  const listedNames = listed
    .map((e) => e?.name)
    .filter((n): n is string => typeof n === 'string');
  const missing = listedNames.filter((n) => !names.includes(n));
  if (missing.length > 0) {
    throw new Error(`shots.json lists ${missing.join(', ')}, which screenshots/ does not hold.`);
  }
  const unlisted = names.filter((n) => !listedNames.includes(n));
  if (unlisted.length > 0) {
    throw new Error(`screenshots/ holds ${unlisted.join(', ')}, which shots.json does not list.`);
  }
  for (const entry of listed) {
    if (typeof entry?.query !== 'string' || !entry.query.includes('shot=')) {
      throw new Error(`shots.json entry ${String(entry?.name)} has no reproducible ?shot= query.`);
    }
  }
}

const shots = assertPlayable();
assertShotsMatchDisk(shots);

// The entry is judged offline, so a web URL in a source file is a broken entry
// even when the page still boots from a cache. Refuse one loudly instead.
function assertOffline() {
  const sources = [
    join(here, 'game', 'index.html'),
    ...readdirSync(join(here, 'game', 'src'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => join(here, 'game', 'src', f)),
  ];
  // A module import, a markup URL, a fetch, a constructed URL or a socket: any
  // of them would make the page depend on the network at run time.
  const absolute = /(?:src|href)\s*=\s*["']https?:\/\/[^"']+|from\s+["']https?:\/\/[^"']+|import\(\s*["']https?:\/\/[^"']+|fetch\(\s*["']https?:\/\/[^"']+|new\s+URL\(\s*["']https?:\/\/[^"']+|WebSocket\(\s*["']wss?:\/\/[^"']+/;
  for (const file of sources) {
    const hit = readFileSync(file, 'utf8').match(absolute);
    if (hit) {
      throw new Error(`${relative(here, file)} loads ${hit[0].slice(0, 70)}: the game must run with no network requests.`);
    }
  }
}
assertOffline();

/** Total size of a directory's files, for the build report. */
function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return total;
}

/**
 * Longest path under a directory, in bytes. The scorer refuses a path over
 * 1000 bytes, and a deeply nested vendor folder is the only way to get there,
 * so it is worth measuring before the hand-in rather than after.
 */
function longestPath(dir: string, prefix = ''): number {
  let longest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const p = join(dir, entry.name);
    longest = Math.max(longest, rel.length);
    if (entry.isDirectory()) longest = Math.max(longest, longestPath(p, rel));
  }
  return longest;
}

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });
}

// Refuse before writing the dossier if the copy would be rejected anyway: a
// game tree over the file cap or a path over the byte cap.
const gameFiles = readdirSync(join(out, 'game'), { recursive: true, withFileTypes: true });
const gameFileCount = gameFiles.filter((e) => e.isFile()).length;
const gameBytes = dirBytes(join(out, 'game'));
if (gameFileCount > CAPS.game_max_files) {
  throw new Error(`game/ holds ${gameFileCount} files; the cap is ${CAPS.game_max_files}.`);
}
if (gameBytes > CAPS.game_max_bytes) {
  throw new Error(`game/ is ${gameBytes} bytes; the cap is ${CAPS.game_max_bytes}.`);
}
const longPath = longestPath(join(out, 'game'));
if (longPath > CAPS.game_path_max_bytes) {
  throw new Error(`a path under game/ is ${longPath} bytes; the cap is ${CAPS.game_path_max_bytes}.`);
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, CAPS));

const vendorSha = createHash('sha256')
  .update(readFileSync(join(here, 'game', 'vendor', 'three.module.min.js')))
  .digest('hex')
  .slice(0, 12);
console.log(`handed in PORT AZUL: ${gameFileCount} files under game/ (${(gameBytes / 1048576).toFixed(1)} MiB), `
  + `${shots.length} screenshots, three.js sha ${vendorSha}, dossier.json written to ${out}`);
