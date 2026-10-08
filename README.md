# Coast 2 Coast Karting

A 3D kart racing game on the real **Coast 2 Coast Karting** circuit on Chenhalls
Road, St Erth, Hayle, Cornwall (TR27 6HJ). Race AI drivers, chase your own ghost,
or race your mates online — keyboard, controller or touch.

**Play it:** open the GitHub Pages URL for this repo (see *Deploying* below).
No install, nothing to boot.

---

## Modes

- **Race** — 3 to 7 AI drivers, 3–10 laps, four difficulty levels. The AI drives the
  same physics as you: no rubber-banding, no extra grip.
- **Time Trial** — flying laps against your own ghost, with a live delta.
- **Online** — quick match or private 4-letter room codes, up to 8 drivers, ready-up
  lobby, start lights synced to the server clock, results table.

## Controls

| Action | Keyboard | Controller (Xbox / PlayStation) |
|---|---|---|
| Accelerate | `↑` / `W` | RT / R2 · A |
| Brake / reverse | `↓` / `S` / `Space` | LT / L2 · X |
| Steer | `←` `→` / `A` `D` | Left stick |
| Camera (Chase / Far / Cockpit / Bumper / Heli) | `C` | Y / Triangle |
| Look behind | `B` | LB / L1 |
| Respawn on track | `R` | Back / Select |
| Pause | `Esc` / `P` | Start / Options |

Menus work with the D-pad/stick, A to choose and B to go back. Controllers rumble on
impacts, kerbs and grass. Touch controls appear on phones and tablets.

## Physics

`src/physics.js` is a planar rigid-body kart on a two-axle tyre model, stepped at 240 Hz:

- Pacejka-style lateral tyre curve per axle, wider/grippier rears than fronts
- longitudinal load transfer (brake = nose dives, front bites; power = rear squats)
- solid rear axle drive with a friction circle, so power and braking eat cornering grip
- brakes biased to the rear, as on a hire kart
- per-axle surfaces: tarmac, kerbs (rumble) and grass (half the grip, lots of drag)
- barriers placed midway between the circuit's closely packed sections, plus tyre walls
  on the perimeter; impulse-based barrier and kart-to-kart collisions

---

## Where the circuit came from

This is the **current** layout, not the one in most satellite imagery.

The circuit was rebuilt — there's a 2016 onboard video titled *"A Lap of the New
circuit at Coast2Coast Karting"*. Esri's aerial imagery still shows the older
pre-rebuild track, which is a genuinely different layout. Tracing that imagery
produces the wrong circuit.

The geometry instead comes from **OpenStreetMap**, surveyed 2025-07-04:

- way `1033520960` — `highway=raceway`, `sport=karting`, `surface=asphalt`, `oneway=yes`
- way `1412164570` — the short `covered=yes` section

Those two join with **0.0 m gaps** into one closed **723.6 m** ring.

### Cross-checks

| Check | Result |
|---|---|
| OSM tags a section `covered=yes` | The onboard video drives through a bridge at that exact point |
| A building mapped `layer=1` (over the track) | Sits **0.7 m** from that same point |
| Corner count | **14** measured vs *"13 distinct turns"* counted in the video |
| Lap length vs lap times | 719 m ÷ the 40–43 s laps quoted under those videos ≈ 17 m/s average — right for a twin-engine hire kart |

The venue advertises ~980 m. That doesn't square with the mapped geometry *or*
the lap times (980 m in 41 s would need an 86 km/h average, which these karts
can't do), so the measured **719 m** is used.

### Start/finish line

Placed on the main straight in front of the paddock — the straight that runs
closest to the mapped clubhouse buildings and spectator seating (22 m away, the
closest of any straight on the lap; the seating is 7.4 m from the tarmac).
Independently, the bridge falls **126 m** later from there, matching the ~7 s
from line to tunnel in the onboard video.

### Elevation

Sampled from **EU-DEM 25 m** along the lap and smoothed: **2.4 m** of total
change, steepest gradient **2.45%** — consistent with descriptions of the
circuit as having little gradient change. A 25 m DEM gives the lie of the land,
not the track's own cut and fill.

**This is a fan-made recreation for practice, not an official map.**

---

## Running it

```bash
node server.js          # then open http://localhost:3001
```

No `npm install`: the server (static files + multiplayer) uses Node built-ins only.
`npm test` runs the physics, lap-counting, AI-race and multiplayer-server tests.

## Publishing

**Single player only, free:** GitHub Pages serves the repo as a static site.
Settings → Pages → Source: *Deploy from a branch* → `main` / `/ (root)`.
Race and Time Trial work there; Online needs the server below.

**Everything including online (recommended):** deploy `server.js` to any Node host. It
serves the game *and* the race server from one URL, so there's nothing to configure.
On [Render](https://render.com) the included `render.yaml` sets it up: New → Blueprint →
pick this repo. Fly.io, Railway or a small VPS (`node server.js`, port from `$PORT`)
work the same way. The server needs no GPU — graphics run on each player's device.

**Both:** keep the game on GitHub Pages and point it at the hosted server by setting
`server` in `config.js`, e.g. `wss://your-app.onrender.com/ws`. A `?server=` URL
parameter overrides it for testing.

The site is also installable as an app (web manifest), and the same files upload to
itch.io as an HTML5 game.

---

## Files

| Path | What it is |
|---|---|
| `index.html`, `style.css` | Page, HUD and menus |
| `src/main.js` | Game shell: sessions (race / trial / online / demo), cameras, HUD, menus, loop |
| `src/physics.js` | Tyre model, collisions, fixed-step world |
| `src/track.js` | Track geometry, barriers, racing line, speed profile, start grid |
| `src/ai.js` | AI drivers |
| `src/race.js` | Lap counting, sector checks, positions and gaps |
| `src/input.js` | Keyboard, gamepad (with rumble) and touch |
| `src/net.js` | Online client: clock sync and interpolation of other karts |
| `src/world.js` | Scenery: terrain, tarmac, kerbs, barriers, fences, buildings, trees, lights |
| `src/kart-model.js` | Procedural kart and driver |
| `src/effects.js` | Skid marks, tyre smoke, grass spray, sparks |
| `src/audio.js` | Procedural engine and effects audio |
| `track-data.js` | The circuit: `[x, y, heading, halfWidthL, halfWidthR, elevation]` per metre |
| `server.js`, `server/` | Static + WebSocket race server (no dependencies) |
| `config.js` | Optional external multiplayer server address |
| `tests/` | `node --test` suites |

## Rendering

Loaded from CDN at runtime, so there are no binary assets in the repo:

- **three.js 0.160** via import map (jsDelivr)
- **Poly Haven CC0 PBR textures** — asphalt, grass, concrete (with procedural fallbacks
  if the CDN is unreachable)
- shadows, image-based lighting from a physical sky, SSAO (High), bloom, SMAA, ACES
  filmic tone mapping; Low / Medium / High presets in Settings

## Times

Time-trial bests and your ghost are stored in **your browser's local storage**.
Online results live only for the session.

A note on lap times: with the mapped geometry (several hairpins under 6 m radius) the
physics gives laps around 50 s for a quick driver, slower than the low-40s quoted for
the real karts — the hand-mapped corners are likely tighter than the real ones.
