# marauders-map

A real world map drawn like the Marauder's Map from Harry Potter and the Prisoner of Azkaban,
with live footsteps of people from Apple Find My (iCloud), OwnTracks or Overland.

```bash
pnpm build                     # web app into dist/, served by the CLI
node server/cli.ts login       # iCloud sign in (SRP + 2FA), session in ~/.marauders-map
node server/cli.ts             # map + API on http://localhost:5317, polls Find My every 60s
pnpm vite                      # dev server on :5316, proxies /api to the CLI on :5317
pnpm typecheck
pnpm exec vitest run
```

URL params: `?open` skips the cover, `?demo` forces demo walkers, `?lat=&lon=&mpp=` start view.

## architecture

```
OpenFreeMap vector tiles (z14) ──▶ map-tiles.ts ──▶ mask meshes (R building, G corridor, B water, A grounds)
                                         │              │
                                         │              ▼  mask target ─▶ blur small + blur large
                                         │                     ─▶ ink-shaders.ts composite: parchment, wobbly ink
                                         │                        walls, hatching, water waves, stipple, folds,
                                         │                        ink reveal, vignette
                                         ├──▶ walls (rings) ─▶ wall-text.ts: instanced glyphs, walls written in Latin
                                         ├──▶ labels ─▶ ink-text.ts: Roman capital room names, italic corridor names
                                         └──▶ paths ─▶ people.ts: corridor graph, A* routing, footprints, name banners

server/cli.ts ─▶ server/icloud.ts (SRP login, 2FA, Find My initClient/refreshClient, polled)
              └▶ server/server.ts ── GET /api/locations, static dist/ ◀── POST /api/owntracks, /api/overland
main.ts polls /api/locations every 10s ──▶ people.applyFix ──▶ walk the route between fixes
```

- Scene units are Web Mercator meters relative to the start center (`createProjection`). Real meters
  times `mercPerMeter` give scene units.
- `cssMpp` is scene units per CSS pixel. Overlays (labels, footprints, banners) keep a constant
  screen size by scaling with it.
- All stylization of streets and buildings happens in screen space from the class mask, so tile seams
  and overlapping features never show.
- Wall text fades in when glyphs are at least ~3 px tall; zoomed out the shader draws hatched double
  walls instead (`uWallText`).
- `server/icloud.ts` is a TypeScript port of timlaing/pyicloud's login. `srpProof` is pinned by a
  test vector from the python `srp` package; change it only with a new vector.
- Two factor codes use the legacy trusted device endpoint or SMS. Apple's newer HSA2 websocket
  bridge (pyicloud `hsa2_bridge.py`) is not ported.
- Colors are raw sRGB (`ColorManagement.enabled = false`), hex values sampled from the film.

## references

`references/style-guide.md` has the film colors, footstep spec, banner shape and fonts.
`docs/find-my-data.md` explains which Find My data can be read and how.
Reference images and clips are copyrighted (Warner Bros, MinaLima): never ship them.
