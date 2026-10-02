# Coast 2 Coast Karting — Hayle Time Trial

A browser 3D time-trial game of the real **Coast 2 Coast Karting** circuit on
Chenhalls Road, St Erth, Hayle, Cornwall (TR27 6HJ). Jump in a kart, do laps,
chase your own ghost.

**Play it:** open the GitHub Pages URL for this repo (see *Deploying* below).
No install, nothing to boot.

---

## Controls

| Action | Key |
|---|---|
| Accelerate | `↑` / `W` |
| Brake / reverse | `↓` / `S` |
| Steer left | `←` / `A` |
| Steer right | `→` / `D` |
| Change camera | `C` — Chase / Cockpit / Nose / Heli |
| Reset to grid | `R` |
| Show best times | `L` |

Touch controls appear automatically on phones and tablets.

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

The game uses ES modules, so it must be served over http — opening
`index.html` from a `file://` path will not work.

```bash
node server.js          # then open http://localhost:3001
```

`server.js` is a zero-dependency static server using only Node built-ins.

## Deploying

The repo is a static site with `index.html` at the root, so GitHub Pages serves
it directly:

**Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**

Pages serves over https, which satisfies the ES-module requirement. On a free
GitHub plan the repo must be public for Pages to work.

---

## Files

| File | What it is |
|---|---|
| `index.html` | Page shell, HUD, import map |
| `game.js` | Engine — scene, PBR materials, post-processing, physics, lap timing, ghost |
| `track-data.js` | The circuit: `[x, y, heading, halfWidthL, halfWidthR, elevation]` per metre |
| `style.css` | HUD and overlay styling |
| `server.js` | Optional local static server |

## Rendering

Loaded from CDN at runtime, so there are no binary assets in the repo:

- **three.js 0.160** via import map (jsDelivr)
- **Poly Haven CC0 PBR textures** — asphalt, grass, concrete (diffuse + normal + roughness)
- Post-processing: SSAO, bloom, SMAA, ACES filmic tone mapping
- Physical sky with atmospheric scattering, used as the environment probe

## Times

Best laps are stored in **your browser's local storage only** — no server, no
account, no global leaderboard. Once you set a lap, a ghost kart replays your
best and a live delta shows how far up or down you are.
