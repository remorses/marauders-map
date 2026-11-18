// Screen space stylization: the flat class mask (see map-tiles.ts) becomes hand inked
// walls, corridors, water and grounds on aged parchment.
//
//   mask target ──▶ blur small (line field) ──┐
//              └──▶ blur large (wall field) ──┴──▶ composite (parchment + ink) ──▶ screen

export const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

export const BLUR_FRAGMENT = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec2 uStep; // one pixel along the blur direction, in uv
  uniform float uSigma; // pixels
  varying vec2 vUv;
  const int TAPS = 9;
  void main() {
    vec4 sum = vec4(0.0);
    float total = 0.0;
    for (int i = -TAPS; i <= TAPS; i++) {
      float t = float(i) / float(TAPS) * 3.0;
      float w = exp(-0.5 * t * t);
      sum += texture2D(uTex, vUv + uStep * t * uSigma) * w;
      total += w;
    }
    gl_FragColor = sum / total;
  }
`

const NOISE = /* glsl */ `
  // Ashima simplex noise, MIT
  vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
  // fbm that drops octaves finer than ~2 screen pixels (pxPerUnit = pixels per noise unit)
  float fbm(vec2 p, float pxPerUnit) {
    float sum = 0.0;
    float amp = 0.5;
    float norm = 0.0;
    for (int i = 0; i < 6; i++) {
      float fade = smoothstep(1.5, 4.0, pxPerUnit);
      sum += snoise(p) * amp * fade;
      norm += amp * fade;
      p = p * 2.03 + vec2(17.1, 9.7);
      pxPerUnit *= 0.5;
      amp *= 0.5;
    }
    return norm > 0.0 ? sum / norm : 0.0;
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`

export const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D uSmall;
  uniform sampler2D uLarge;
  uniform vec2 uResolution; // device pixels
  uniform vec2 uCenter; // scene meters at screen center
  uniform float uMpp; // scene meters per device pixel
  uniform float uPx; // device pixel ratio
  uniform float uTime;
  uniform float uReveal; // 0..1 ink spreading from the center
  uniform float uBlob; // 1 while opening: the maroon blob blooms first, 0 while the ink drains
  uniform float uInnerLevel;
  uniform float uWallText; // 1 when walls are written as text (see wall-text.ts)
  uniform vec3 uPaperLight;
  uniform vec3 uPaperDark;
  uniform vec3 uStain;
  uniform vec3 uInk;
  varying vec2 vUv;
  ${NOISE}

  float iso(float f, float level, float halfWidth) {
    float d = abs(f - level) / max(fwidth(f), 1e-5);
    return 1.0 - smoothstep(halfWidth - 0.7, halfWidth + 0.7, d);
  }

  // Broad nib quill: the stroke is thick when it moves across the nib edge and hairline thin
  // along it. The field gradient gives the stroke normal, so the width follows the direction.
  const vec2 NIB_EDGE = vec2(0.819, 0.574); // nib held at 35 degrees
  float nibPen(float f, float level, float halfWidth, float roughness) {
    vec2 g = vec2(dFdx(f), dFdy(f));
    float gl = max(length(g), 1e-5);
    float d = abs(f - level) / gl + roughness;
    float nib = 0.28 + 1.0 * abs(dot(g / gl, NIB_EDGE));
    float hw = halfWidth * nib;
    return 1.0 - smoothstep(hw - 0.55, hw + 0.55, d);
  }

  // Noise with a feature size in screen pixels but anchored in the world: blends the two
  // nearest power of two world scales, so panning never swims and zooming only morphs.
  float octaveNoise(vec2 wp, float sizePx, float seed) {
    float lg = log2(sizePx * uMpp);
    float o = floor(lg);
    float a = exp2(o);
    return mix(snoise(wp / a + seed), snoise(wp / (a * 2.0) + seed + 7.3), lg - o);
  }
  float octaveFbm(vec2 wp, float sizePx, float seed) {
    float lg = log2(sizePx * uMpp);
    float o = floor(lg);
    float a = exp2(o);
    float pxPerUnit = sizePx * exp2(o - lg);
    return mix(fbm(wp / a + seed, pxPerUnit), fbm(wp / (a * 2.0) + seed + 7.3, pxPerUnit * 2.0), lg - o);
  }
  vec2 octaveNoise2(vec2 wp, float sizePx, float seed) {
    return vec2(octaveNoise(wp, sizePx, seed), octaveNoise(wp, sizePx, seed + 31.7));
  }

  void main() {
    vec2 px = vUv * uResolution;
    vec2 wp = uCenter + (px - 0.5 * uResolution) * uMpp;
    // world position measured in device pixels: anchored patterns at screen scale
    vec2 wpx = wp / uMpp;

    // a hand drawn line drifts slowly and evenly, it does not crinkle
    vec2 wobPx = octaveNoise2(wp, 110.0 * uPx, 0.0) * 2.2 * uPx + octaveNoise2(wp, 26.0 * uPx, 5.0) * 0.45 * uPx;
    vec2 uv = vUv + wobPx / uResolution;
    vec4 S = texture2D(uSmall, uv);
    vec4 L = texture2D(uLarge, uv);
    // the pen went over some stretches twice, never exactly on the first stroke
    vec2 retracePx = wobPx + octaveNoise2(wp, 45.0 * uPx, 11.0) * 1.6 * uPx;
    vec4 S2 = texture2D(uSmall, vUv + retracePx / uResolution);
    float retrace = smoothstep(0.15, 0.45, octaveNoise(wp, 120.0 * uPx, 17.0)) * 0.45;

    // pen pressure swells and thins along the stroke, ink blots where the quill paused,
    // and the pen lifts now and then
    float pressure = 0.5 + 0.5 * octaveNoise(wp, 70.0 * uPx, 3.3);
    float blot = smoothstep(0.55, 0.9, octaveNoise(wp, 24.0 * uPx, 41.0));
    float w = uPx * (0.6 + 1.0 * pressure + 0.9 * blot);
    // fibrous edge where the ink soaked into the paper
    float rough = (hash(floor(wpx / (1.5 * uPx))) - 0.5) * 0.5 * uPx + octaveNoise(wp, 5.0 * uPx, 51.0) * 0.35 * uPx;
    float penLift = smoothstep(-0.72, -0.55, octaveNoise(wp, 38.0 * uPx, 9.0));

    float inBuilding = smoothstep(0.45, 0.55, S.r);
    float inWater = smoothstep(0.45, 0.55, S.b);
    float inGrounds = smoothstep(0.45, 0.55, S.a) * (1.0 - inBuilding) * (1.0 - inWater);

    float ink = 0.0;

    // walls: outer outline, inner outline and hand hatching between them
    float wallLine = max(nibPen(S.r, 0.5, w * 1.15, rough), nibPen(S2.r, 0.5, w * 0.55, rough) * retrace);
    ink = max(ink, wallLine * (1.0 - 0.55 * uWallText) * mix(1.0, penLift, 0.5));
    float inner = nibPen(L.r, uInnerLevel, w * 0.75, rough) * inBuilding * (1.0 - uWallText) * penLift;
    ink = max(ink, inner);
    float wallBand = inBuilding * (1.0 - smoothstep(uInnerLevel - 0.02, uInnerLevel + 0.02, L.r));
    // hatch strokes: uneven spacing and angle, each stroke stops and restarts
    float hatchSpacing = 5.0 * uPx;
    float hu = (wpx.x + wpx.y * 0.92) / hatchSpacing + octaveNoise(wp, 60.0 * uPx, 13.0) * 0.45;
    float hatchLine = abs(fract(hu) - 0.5) * hatchSpacing;
    float hatchStroke = step(-0.35, snoise(vec2(floor(hu) * 1.7, (wpx.x - wpx.y) / (16.0 * uPx))));
    float hatch = (1.0 - smoothstep(0.3 * uPx, 0.85 * uPx, hatchLine)) * hatchStroke;
    ink = max(ink, hatch * wallBand * 0.7 * (1.0 - uWallText));

    // corridors: two walls, hidden where a building is drawn on top
    float corridorEdge = max(nibPen(S.g, 0.5, w, rough), nibPen(S2.g, 0.5, w * 0.5, rough) * retrace) * penLift;
    ink = max(ink, corridorEdge * (1.0 - inBuilding) * (1.0 - inWater * 0.7) * (1.0 - 0.45 * uWallText));

    // water: shore line plus wavy strokes of uneven length
    ink = max(ink, max(nibPen(S.b, 0.5, w, rough), nibPen(S2.b, 0.5, w * 0.5, rough) * retrace));
    // engraved sea: long gentle swells at screen scale, so zooming out never turns them into zigzags
    float waveSpacing = 8.0 * uPx;
    float wv = (wpx.y + sin(wpx.x / (16.0 * uPx) + wpx.y / (50.0 * uPx)) * 1.4 * uPx + octaveNoise(wp, 90.0 * uPx, 21.0) * 2.5 * uPx) / waveSpacing;
    float wave = abs(fract(wv) - 0.5) * waveSpacing;
    float waveBreak = smoothstep(0.0, 0.35, snoise(vec2(wpx.x / (60.0 * uPx), floor(wv) * 7.1)));
    ink = max(ink, (1.0 - smoothstep(0.3 * uPx, 0.85 * uPx, wave)) * waveBreak * inWater * (1.0 - inBuilding) * 0.7);

    // grounds: broken outline and stippled grass, dots anchored to the world
    float dash = smoothstep(-0.2, 0.25, octaveNoise(wp, 14.0 * uPx, 27.0));
    ink = max(ink, nibPen(S.a, 0.5, w * 0.8, rough) * dash * (1.0 - inBuilding) * 0.85);
    float cellPx = 6.0 * uPx;
    vec2 cell = floor(wpx / cellPx);
    vec2 jitter = vec2(hash(cell), hash(cell + 3.1));
    float dotD = length(wpx - (cell + 0.2 + 0.6 * jitter) * cellPx);
    float stipple = (1.0 - smoothstep(0.5 * uPx, 1.1 * uPx, dotD)) * step(0.55, hash(cell + 7.7));
    ink = max(ink, stipple * inGrounds * 0.6);

    // ink density: blotchy, sometimes nearly dry
    float density = 0.78 + 0.22 * snoise(wp / 4.0 + 11.0);
    density *= 0.85 + 0.15 * hash(floor(wpx / (2.0 * uPx)));
    ink *= density;

    // parchment
    float pxPerMeter = 1.0 / uMpp;
    // tone and stains keep a constant size on screen, like marks on a real sheet
    float tone = octaveFbm(wp, 700.0 * uPx, 0.0) * 0.5 + 0.5;
    vec3 paper = mix(uPaperLight, uPaperDark, smoothstep(0.25, 0.95, tone));
    float grain = fbm(wp / 1.2, 1.2 * pxPerMeter);
    paper *= 1.0 + grain * 0.05;
    float fibers = snoise(vec2(wp.x / 0.4, wp.y / 6.0));
    paper *= 1.0 - smoothstep(0.55, 1.0, fibers) * 0.05 * smoothstep(1.0, 4.0, 0.4 * pxPerMeter);

    // stains with darker rims
    float s = octaveFbm(wp, 260.0 * uPx, 40.0);
    float stain = smoothstep(0.42, 0.55, s);
    float rim = smoothstep(0.40, 0.44, s) - smoothstep(0.44, 0.50, s);
    paper = mix(paper, paper * uStain * 1.25, stain * 0.18 + rim * 0.14);

    // fold creases of the folded map, about one panel per screen width. Zooming out drops every
    // other crease smoothly, so the folds never pile up into a dense grid.
    vec2 foldWarp = vec2(snoise(wp.yx / 700.0 + 3.0), snoise(wp / 700.0 - 5.0)) * 9.0 * max(1.0, uMpp);
    vec2 fw = wp + foldWarp;
    vec2 crease2 = vec2(0.0);
    vec2 bulge2 = vec2(0.0);
    for (int axis = 0; axis < 2; axis++) {
      float sizePx = (axis == 0 ? 620.0 : 820.0) * uPx;
      float lg = log2(sizePx * uMpp);
      float o = floor(lg);
      float a = exp2(o);
      float t = (axis == 0 ? fw.x : fw.y) / a;
      float k = floor(t + 0.5);
      float weight = mod(k, 2.0) < 0.5 ? 1.0 : 1.0 - (lg - o);
      float d = abs(t - k) * a / uMpp;
      crease2[axis] = exp(-d / (1.5 * uPx)) * weight;
      bulge2[axis] = (fract(t) - 0.5) * weight;
    }
    float crease = crease2.x + crease2.y * 0.8;
    paper *= 1.0 - crease * 0.16 + bulge2.x * 0.06 - bulge2.y * 0.04;
    paper += crease2.x * 0.04;

    // ink spreading out from the wand tap point when the map opens, wicking through the
    // paper with a ragged edge and a darker rim where the ink pools
    float maxR = length(0.5 * uResolution);
    float r = length(px - 0.5 * uResolution) / maxR;
    float ragged = fbm(px / (60.0 * uPx), 60.0) * 0.16 + snoise(px / (14.0 * uPx)) * 0.02;
    float spread = uReveal * 1.35 + ragged - 0.05;
    float revealed = 1.0 - smoothstep(spread - 0.05, spread, r);
    float inkRim = smoothstep(spread - 0.09, spread - 0.025, r) * (1.0 - smoothstep(spread - 0.02, spread + 0.005, r));
    ink *= revealed;

    // ink sits in the paper: slightly darker halo, then the stroke
    vec3 col = mix(paper, paper * 0.86, clamp(ink * 1.6, 0.0, 1.0) * 0.25);
    col = mix(col, uInk, clamp(ink, 0.0, 1.0) * 0.92);

    // pooled ink at the spreading front, and the maroon blob that blooms first
    float spreading = 1.0 - smoothstep(0.75, 1.0, uReveal);
    col = mix(col, uInk * 1.1, inkRim * 0.55 * spreading * step(0.001, uReveal));
    float blobR = (0.04 + uReveal * 0.5) * (1.0 + ragged * 2.5);
    float blob = (1.0 - smoothstep(blobR - 0.01, blobR, r)) * (1.0 - smoothstep(0.15, 0.55, uReveal)) * step(0.001, uReveal) * uBlob;
    col = mix(col, vec3(0.31, 0.1, 0.07), blob * 0.85);

    gl_FragColor = vec4(col, 1.0);
  }
`
