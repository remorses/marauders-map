---
title: Marauder's Map style guide
description: Colors, line style, footsteps, name banners, fonts and animations for a web recreation of the Marauder's Map, measured from film frames and MinaLima prop photos.
---

# Marauder's Map style guide

Two looks exist. Pick one and stay consistent:

| look | source | feel |
| --- | --- | --- |
| **Film (PoA 2004)** | `frames/*` | warm ochre parchment in candle/wand light, dark brown ink, walls drawn **with lines of handwritten Latin text**, heavy vignette |
| **Prop / MinaLima** | `images/full-map-*`, `images/prop-*` | pale cream paper, sepia line drawing, hatched double walls, compass roses, maroon cover diamond |

The film close-ups (footsteps, banners, ink reveal) are the best motion reference. The prop scans are the best layout reference for rooms and corridors.

## Colors

Sampled with ImageMagick (`-kmeans` and 1x1 averages) from the files named in the last column.

### Parchment

| role | hex | source |
| --- | --- | --- |
| film parchment, lit | `#A48B5A` | `frames/pettigrew-footsteps-closeup-008.jpg` |
| film parchment, shadow | `#896D3F` | same |
| film parchment, deep edge / vignette | `#64461F` | same |
| prop parchment, light | `#E4D2B0` | `images/full-map-unfolded-minalima.png` |
| prop parchment, mid | `#D0BB97` | same |
| prop parchment, stain / fold | `#B39D7D` | same |
| aged texture base | `#EDD3A6` | `images/parchment-texture-aged.jpg` |
| aged texture edge burn | `#CD9F64` | same |
| cover parchment (warm) | `#DEBB80` / `#EACE99` | `images/cover-title-castle-parchment.jpg` |

Recommended app palette (film look, but readable on screens): base `#D9C29A`, mid `#C2A472`, fold shadow `#9C7F4E`, vignette `#5A3E1C` at the edges with radial falloff.

### Ink

| role | hex | source |
| --- | --- | --- |
| main ink (walls, text) film | `#3A260E` | pettigrew frame |
| darkest ink | `#271806` / `#271D0F` | snape frame, Pettigrew banner close-up |
| footprint ink (reddish brown, soft) | `#6C3F19` | pettigrew frame, footprint centre |
| banner shading (sepia wash) | `#503C21` → `#725B3D` | Pettigrew banner |
| prop line ink (sepia) | `#6E4738` | MinaLima scan |
| prop red-brown ink | `#4E231B` | panorama scan |
| cover diamond maroon | `#4E1A12` (lit prop ~`#6B1E1A`) | cover scan |
| reveal ink blob | `#381E13` → `#5F452F` | `frames/reveal-ink-spread-012.jpg` |

Accents on the prop: small **red-orange flourish strokes** (`#B5482A` approx) near compass roses and labels, and a few dark green trees. Use them sparingly.

## Line style

- **Walls in the film are made of text.** Corridors are outlined by lines of tiny cursive Latin ("Marauder est... omnibus... itinerarium") written along the wall direction, often in 2 to 4 parallel rows. Rotated Roman capitals label areas: `MARAVDERS`, `DIFICIVM`, `HOGWARTS`, with **V for U**. See `frames/map-title-dumbledore-label-*.jpg`, `images/name-banner-peter-pettigrew-closeup.jpg`.
- **Walls on the prop are double lines** with diagonal hatching or stippling between them (`images/minalima-edition-corridors-closeup.jpg`). Line weight about 1 to 1.5 px at 100% zoom, slightly wobbly.
- **Stairs**: a band of parallel short lines, curved staircases as fan-shaped radial lines.
- **Round towers**: concentric circles with hatching, text running around the circle.
- **Compass roses** with long thin radial rays across the page.
- **Doors**: gaps in the wall; small rectangle furniture inside rooms.
- **Fold creases**: the map is an accordion of vertical panels (`images/full-map-panorama-flat.jpg`, `images/prop-unfolded-photo.jpg`). Draw a soft shadow and light crease every panel.
- Labels follow the wall or arc direction (curved text on paths).

Rendering tips: draw walls as polylines, then jitter each vertex 0.3 to 0.8 px and vary width 0.8x to 1.2x. For text walls, lay glyphs along the polyline with a cursive font, size 6 to 9 px at 100% zoom, random rotation of ±4°.

## Footsteps

Measured from `frames/pettigrew-footsteps-closeup-008.jpg` and `images/name-banner-peter-pettigrew-closeup.jpg`.

```
   walking direction ──▶

        ●  ⬭⬭⬭⬭           ●  ⬭⬭⬭⬭             each print = sole + heel
                ●  ⬭⬭⬭⬭           ●  ⬭⬭⬭⬭     sole: ellipse L x 0.45L
   older ░ ░ fade                   newest      heel: circle 0.35L, gap 0.15L
```

- One print = **two separate blobs**: an oval sole (length `L`, width ~0.45L, slightly fatter at the toe) plus a small round heel (diameter ~0.35L) behind it, with a clear gap of ~0.15L. No toes, no tread detail.
- **Left/right alternate**. Lateral offset between feet ~0.6 to 0.9L. Forward distance between consecutive prints (half stride) ~1.3 to 1.6L.
- Standing still: the two feet end up side by side (Pettigrew frame).
- **Size**: sole length L ≈ 1/12 of the name banner width, or about the cap height of the banner name. Example: banner 240 px wide → L ≈ 18 to 22 px.
- Edges are soft (ink bleed), not crisp vectors. Use a blurred ellipse or a soft texture, opacity 0.85 to 0.9.
- **Trail**: 4 to 6 prints clearly visible, older ones fade to faint smudges then vanish. Fade time about 1 to 2 s per print (estimate from the 0.5 s frame steps, not frame-accurate).
- **Cadence**: new print every ~0.45 to 0.55 s for a normal walk, faster (~0.3 s) when running (estimate; check `video/poa-pettigrew-on-map-*.mp4` at 66 to 110 s).
- **Appear**: each print inks in over ~120 ms (opacity 0 → 0.9, scale 1.1 → 1.0).
- Fan art often uses black shoe silhouettes (`images/footprints-pattern-black.jpg`). Avoid that; the film prints are brown blobs.

## Name banner

See `images/name-banner-peter-pettigrew-closeup.jpg`, `frames/harry-and-snape-labels-026.jpg`.

- A **scroll ribbon** drawn in ink: the flat middle panel holds the name, both ends curl over (one end rolls up and back like a tube, the other swings down into a long thin tail that ends in a curl).
- Panel slightly wavy (top and bottom edges are gentle S curves), a little skewed, not a rectangle.
- Shading: sepia wash in the curled parts (`#503C21`), fine **hatching lines** following the curl on the Snape banner, light parchment inside the panel.
- Text: broad-nib italic with spiky serifs; first name on one line, surname below, larger and offset right ("Severus / Snape", "Peter / Pettigrew").
- Placement: banner sits beside the footsteps (up and to one side), tail pointing toward the feet, and moves with the person.
- Size: the name cap height ≈ 1 sole length.

## Fonts

All in `fonts/`, free licenses. `font-specimen.png` renders each one.

| use | font | license | file / URL |
| --- | --- | --- | --- |
| name banners (best) | **IM Fell DW Pica Italic** | OFL | `IMFePIit28P.ttf`, https://fonts.google.com/specimen/IM+Fell+DW+Pica |
| name banners (alt) | IM Fell English Italic, Fondamento Italic | OFL | `IMFeENit28P.ttf`, `Fondamento-Italic.ttf`, https://fonts.google.com/specimen/Fondamento |
| Roman caps (`MARAVDERS`, `MOONY WORMTAIL`) | **IM Fell English SC** / IM Fell English | OFL | `IMFeENsc28P.ttf`, `IMFeENrm28P.ttf`, https://fonts.google.com/specimen/IM+Fell+English+SC |
| "Messrs ... are proud to present" | IM Fell English Italic | OFL | `IMFeENit28P.ttf` |
| text walls (tiny Latin scrawl) | **Mrs Saint Delafield** (or Homemade Apple) | OFL / Apache 2.0 | `MrsSaintDelafield-Regular.ttf`, `HomemadeApple-Regular.ttf` |
| spiky gothic alt for names | Grenze Gotisch, Pirata One | OFL | `GrenzeGotisch[wght].ttf`, `PirataOne-Regular.ttf` |
| clean caps alt | Cinzel | OFL | `Cinzel[wght].ttf` |
| heavy blackletter (rarely) | UnifrakturMaguntia | OFL | `UnifrakturMaguntia-Book.ttf` |

The original lettering is hand drawn by Miraphora Mina; no font matches exactly. IM Fell is the closest family. The crypticsy recreation uses IM Fell English for titles and Shadows Into Light / Satisfy for script. Fan fonts named "Marauder's Map" exist on free font sites but are personal-use only; skipped.

## Animations

### Ink reveal ("I solemnly swear that I am up to no good")

`frames/reveal-ink-spread-*.jpg` (0.5 s apart).

1. Blank parchment, folds visible (0 s).
2. Title words fade in first, near the tap point: "MOONY WORMTAIL" (~0.5 s).
3. An **ink blob blooms** from the wand tap point: irregular, splotchy edge, dark maroon-brown (~1 s).
4. Blob grows into the cover diamond, and the drawings (castle, banners, flourishes) grow outward from it like ink wicking through paper (1.5 to 3 s).
5. Then corridors and text walls spread across the rest of the map panels.

Implementation: a noise-distorted radial mask (fbm noise threshold that grows over time from the tap point), with a darker 2 to 4 px rim at the mask edge where ink pools. Text strokes can also draw on with stroke-dashoffset.

### Mischief managed

`frames/mischief-managed-ink-fade-*.jpg`: the reverse. Ink fades and drains back toward the centre, the cover diamond last. About 2 to 3 s.

### Footsteps

See the footsteps section. Prints are stamped at fixed distance intervals along the path (not time), then each print runs its own fade timer. Name banner follows the latest print with a small lag (lerp ~0.15 per frame).

### Folds

The prop is an accordion fold: about 6 to 8 vertical panels on the main sheet, plus flaps that open up and down (`images/prop-unfolded-photo.jpg`, `images/prop-unfolded-overhead.jpg`, `images/minalima-edition-popup-map.jpg`). For an opening animation, rotate panels around their vertical crease edges with alternating ±angle, 120 ms stagger per panel.

### Film camera

The film never shows the full map. The camera hovers close, drifts and rotates slowly, with shallow depth of field and a dark vignette. A slow pan plus a small tilt sells the effect better than a flat top-down view.

## Existing web recreations

| repo | stack | notes |
| --- | --- | --- |
| https://github.com/crypticsy/the-marauders-map (demo https://crypticsy.github.io/the-marauders-map/) | React, @react-three/fiber, three 0.151 | closest to our goal. Characters walk on a NavMesh with a BehaviorSystem. Footprints in `src/components/Character3D.tsx`: pool of 8 textured quads per character, `STRIDE = 0.6`, `FOOT_SPREAD = 0.15`, foot size `0.32 x 0.8`, 6 trail steps, `FADE = 0.9` s, opacity 0.88, right foot mirrors left texture. Fonts IM Fell English + Shadows Into Light |
| https://github.com/icochi/The-Marauders-Map (90 stars) | plain HTML/CSS | CSS keyframe footprints: PNG sprites for left/right foot, `footsteps` and `footHide` keyframes, right foot delayed 1 s, a "cloud" PNG mask for fading, name banner as SVG with `nameShow` animation, font Apple Chancery |
| https://github.com/Rorothejedi/poc_marauders_footsteps_cursor (demo https://rorothejedi.github.io/poc_marauders_footsteps_cursor/) | vanilla JS | footsteps follow the mouse cursor |
| https://github.com/cartland/Marauder | React web + Android + Firestore | Halloween party: random walks between rooms on multiple screens |
| https://github.com/willymaps/marauder | Mapbox GL + Turf.js | real-world map styled as the Marauder's Map |
| https://github.com/schollz/find-maraudersmap | ArcGIS / Mapbox | indoor positioning shown on a Marauder's Map |
| https://github.com/arank/marauders-map (732 stars) | Chrome extension | Facebook Messenger locations, not a visual reference |

After Effects tutorials that show the footstep timing: https://www.youtube.com/watch?v=E1GUqbA9fs0, https://www.youtube.com/watch?v=KxMDXBPOvmY.

## Sources

- Images: Pinterest searches "marauders map minalima", "marauders map footprints names", "parchment paper texture old"; cosmos.so search "marauders map". Original pin/element IDs are in the file names under `raw/`. Copyrighted (Warner Bros / MinaLima): reference only, do not ship.
- Video: https://www.youtube.com/watch?v=IR5RrNXy0ek (Pettigrew on the map, Filmorphics), https://www.youtube.com/watch?v=9FPWlC7xfdU (map reveal), https://www.youtube.com/watch?v=MzbOnrLYNlg (end credits footsteps), https://www.youtube.com/watch?v=UNdP4FVfO1s (credits easter egg), https://www.youtube.com/watch?v=p5eTa2rxF88 (RNVFX fan footsteps).
