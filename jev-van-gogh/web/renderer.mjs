// Deterministic painterly renderer. The input is a grid of colour
// distributions; the output is an RGBA buffer that looks like thick oil paint.
//
//   underpainting  = per-pixel mean colour, bilinearly interpolated
//   strokes        = colours sampled from the distribution with spatially
//                    correlated noise, so neighbouring strokes agree
//   relief         = entropy of the distribution: where Jev is unsure, the
//                    paint gets thick, visible, and varied
//   lighting       = a height map lit from the upper-left
import { prepare } from "./art.mjs";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (t) => t * t * (3 - 2 * t);

export function renderPaint(result, width = 560) {
  const started = performance.now();
  const times = {};
  let mark = started;
  const lap = (name) => {
    const now = performance.now();
    times[name] = Math.round(now - mark);
    mark = now;
  };

  const { size: n, pixels } = prepare(result);
  const unit = width / 560;

  // ---- pigment table: every distinct colour used anywhere, plus per-cell weights
  const pigments = [];
  const ids = new Map();
  const cellWeights = pixels.map((px) => {
    const m = new Map();
    px.colors.forEach((rgb, k) => {
      const c = rgb.map(Math.round);
      const key = c.join(",");
      if (!ids.has(key)) {
        ids.set(key, pigments.length);
        pigments.push(c);
      }
      const id = ids.get(key);
      m.set(id, (m.get(id) || 0) + px.weights[k]);
    });
    return m;
  });
  const active = pigments
    .map((_, id) => id)
    .filter((id) => cellWeights.some((m) => (m.get(id) || 0) > 0));
  const K = active.length;
  const W = cellWeights.map((m) => Float64Array.from(active, (id) => m.get(id) || 0));

  // ---- bilinear sampling helpers over the n×n grid
  const cell = (x, y) => {
    const gx = clamp((x / width) * n - 0.5, 0, n - 1);
    const gy = clamp((y / width) * n - 0.5, 0, n - 1);
    const ix = Math.floor(gx), iy = Math.floor(gy);
    return {
      i00: iy * n + ix,
      i10: iy * n + Math.min(n - 1, ix + 1),
      i01: Math.min(n - 1, iy + 1) * n + ix,
      i11: Math.min(n - 1, iy + 1) * n + Math.min(n - 1, ix + 1),
      fx: gx - ix,
      fy: gy - iy,
    };
  };
  const lerp4 = (c, f) =>
    f(c.i00) * (1 - c.fx) * (1 - c.fy) +
    f(c.i10) * c.fx * (1 - c.fy) +
    f(c.i01) * (1 - c.fx) * c.fy +
    f(c.i11) * c.fx * c.fy;
  const lumaOf = (i) => {
    const m = pixels[i].mean;
    return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  };
  const luma = (x, y) => lerp4(cell(x, y), lumaOf);

  // ---- uncertainty: entropy of the interpolated distribution, squashed to 0..1
  const spreadExact = (x, y) => {
    const c = cell(x, y);
    let h = 0;
    for (let k = 0; k < K; k++) {
      const p = lerp4(c, (i) => W[i][k]);
      if (p > 0) h -= p * Math.log(p);
    }
    return 1 - Math.exp(-h);
  };
  const M = 128;
  const mask = new Float32Array(M * M);
  for (let j = 0; j < M; j++)
    for (let i = 0; i < M; i++)
      mask[j * M + i] = spreadExact(((i + 0.5) / M) * width, ((j + 0.5) / M) * width);
  const spread = (x, y) =>
    mask[
      Math.min(M - 1, Math.floor((y / width) * M)) * M +
        Math.min(M - 1, Math.floor((x / width) * M))
    ];
  // no relief below 0.48, full relief above 0.80
  const relief = (s) => smooth(clamp((s - 0.48) / 0.32, 0, 1));

  // ---- spatially correlated categorical sampling
  // One smooth Gaussian noise field per pigment. Gumbel-max over log(p) + noise
  // picks a pigment; because the noise is smooth, nearby samples agree.
  const hash = (x, y, k) => {
    let h =
      Math.imul(x + 137, 374761393) ^
      Math.imul(y + 317, 668265263) ^
      Math.imul(k + 79, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (((h ^ (h >>> 16)) >>> 0) + 0.5) / 4294967296;
  };
  const pitch = width / 85;
  const side = Math.ceil(width / pitch) + 2;
  const noise = active.map((id) =>
    Float64Array.from({ length: side * side }, (_, i) => {
      const x = i % side, y = Math.floor(i / side);
      return (
        Math.sqrt(-2 * Math.log(hash(x, y, id * 2))) *
        Math.cos(2 * Math.PI * hash(x, y, id * 2 + 1))
      );
    }),
  );
  const normalCdf = (z) => {
    const a = Math.abs(z), t = 1 / (1 + 0.2316419 * a);
    const d = 0.3989422804 * Math.exp((-a * a) / 2);
    const p =
      1 -
      d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z >= 0 ? p : 1 - p;
  };
  const sampled = new Int16Array(width * width).fill(-1);
  const sample = (x, y) => {
    const index = y * width + x;
    if (sampled[index] >= 0) return sampled[index];
    const c = cell(x + 0.5, y + 0.5);
    const nx = x / pitch, ny = y / pitch;
    const xx = Math.floor(nx), yy = Math.floor(ny);
    const u = smooth(nx - xx), v = smooth(ny - yy);
    const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
    const norm = Math.hypot(...w);
    let best = -Infinity, chosen = active[0];
    for (let k = 0; k < K; k++) {
      const p = lerp4(c, (i) => W[i][k]);
      if (p <= 0) continue;
      const f = noise[k];
      const z =
        (f[yy * side + xx] * w[0] +
          f[yy * side + xx + 1] * w[1] +
          f[(yy + 1) * side + xx] * w[2] +
          f[(yy + 1) * side + xx + 1] * w[3]) /
        norm;
      const uniform = clamp(normalCdf(z), 1e-9, 1 - 1e-9);
      const score = Math.log(p) - Math.log(-Math.log(uniform));
      if (score > best) {
        best = score;
        chosen = active[k];
      }
    }
    sampled[index] = chosen;
    return chosen;
  };
  lap("setup");

  // ---- underpainting: smooth mean colour + faint canvas weave in the height map
  const image = new Uint8ClampedArray(width * width * 4);
  const height = new Float32Array(width * width);
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const c = cell(x + 0.5, y + 0.5), i = y * width + x;
      for (let ch = 0; ch < 3; ch++)
        image[i * 4 + ch] = lerp4(c, (j) => pixels[j].mean[ch]);
      image[i * 4 + 3] = 255;
      height[i] = 0.015 * unit * Math.sin((x / unit) * 0.7) * Math.sin((y / unit) * 0.8);
    }
  lap("underpaint");

  // ---- strokes
  let seed = 93421;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const eps = (width / n) * 0.35;
  const gradient = (x, y) => [
    luma(x + eps, y) - luma(x - eps, y),
    luma(x, y + eps) - luma(x, y - eps),
  ];
  // strokes follow iso-luminance contours (perpendicular to the gradient)
  const steer = (x, y, previous) => {
    const [gx, gy] = gradient(x, y);
    let target = Math.hypot(gx, gy) > 2 ? Math.atan2(gy, gx) + Math.PI / 2 : previous;
    while (target - previous > Math.PI / 2) target -= Math.PI;
    while (target - previous < -Math.PI / 2) target += Math.PI;
    return previous + 0.25 * (target - previous);
  };

  const STROKES = 2300, DETAIL_FROM = 2100;
  for (let s = 0; s < STROKES; s++) {
    const cx = random() * width, cy = random() * width;
    const sp = spread(cx, cy);
    const richness = relief(sp);
    if (random() > richness) continue; // confident areas keep the smooth underpainting
    const detail = s >= DETAIL_FROM;
    if (detail && random() > richness) continue;

    const [gx, gy] = gradient(cx, cy);
    const angle =
      Math.hypot(gx, gy) > 3
        ? Math.atan2(gy, gx) + Math.PI / 2
        : -0.4 + 0.3 * Math.sin((cx / width) * 6);
    const radius = (detail ? 1.5 + random() * 2 : 9 + 18 * (1 - sp) + random() * 5) * unit;

    // broad strokes use the locally dominant sample; detail strokes keep rare ones
    let pigment;
    if (detail) pigment = pigments[sample(Math.floor(cx), Math.floor(cy))];
    else {
      const votes = new Map();
      for (let oy = -2; oy <= 2; oy++)
        for (let ox = -2; ox <= 2; ox++) {
          const sx = clamp(Math.round(cx + ox * 4 * unit), 0, width - 1);
          const sy = clamp(Math.round(cy + oy * 4 * unit), 0, width - 1);
          const id = sample(sx, sy);
          votes.set(id, (votes.get(id) || 0) + 1);
        }
      pigment = pigments[[...votes].sort((a, b) => b[1] - a[1])[0][0]];
    }

    const depth =
      (detail ? 0.15 + richness * 1.7 : 0.05 + richness * (2.3 + random() * 2.1)) * unit;
    const phase = random() * 6.28, profile = random(), edgeBias = random() - 0.5;
    const steps = detail ? 2 : 4;
    const step = (detail ? 2 : 4 + 12 * (1 - sp) + random() * 2) * unit;
    const baseLuma = luma(cx, cy);

    const trace = (sign) => {
      let x = cx, y = cy, theta = angle;
      const points = [];
      for (let j = 0; j < steps; j++) {
        theta = clamp(steer(x, y, theta), angle - 0.22, angle + 0.22);
        const nx = x + Math.cos(theta) * step * sign, ny = y + Math.sin(theta) * step * sign;
        if (j > 0 && Math.abs(luma(nx, ny) - baseLuma) > 18) break; // stop at edges
        x = nx; y = ny;
        points.push([x, y]);
      }
      return points;
    };
    const path = [...trace(-1).reverse(), [cx, cy], ...trace(1)];
    const xs = path.map((p) => p[0]), ys = path.map((p) => p[1]);
    const minX = Math.max(0, Math.floor(Math.min(...xs) - radius * 1.3));
    const maxX = Math.min(width, Math.ceil(Math.max(...xs) + radius * 1.3));
    const minY = Math.max(0, Math.floor(Math.min(...ys) - radius * 1.3));
    const maxY = Math.min(width, Math.ceil(Math.max(...ys) + radius * 1.3));
    const segments = path.slice(1).map(([bx, by], j) => {
      const [ax, ay] = path[j], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      return { ax, ay, dx, dy, inv: 1 / l2, normal: 1 / Math.sqrt(l2) / radius };
    });

    for (let y = minY; y < maxY; y++)
      for (let x = minX; x < maxX; x++) {
        // nearest point on the polyline -> (u along, v across) stroke coordinates
        let nearest = Infinity, u = 0, v = 0;
        for (let j = 0; j < segments.length; j++) {
          const g = segments[j];
          const t = clamp(((x - g.ax) * g.dx + (y - g.ay) * g.dy) * g.inv, 0, 1);
          const ex = x - g.ax - t * g.dx, ey = y - g.ay - t * g.dy;
          const d = ex * ex + ey * ey;
          if (d < nearest) {
            nearest = d;
            u = (2 * (j + t)) / segments.length - 1;
            v = (ex * -g.dy + ey * g.dx) * g.normal;
          }
        }
        if (nearest > radius * radius * 1.4) continue;
        const tip = 0.94 + 0.08 * Math.cos(v * 2 + phase) + edgeBias * v * 0.16;
        const sideW = 0.8 + 0.13 * Math.cos(u * 2 + phase) + (profile - 0.5) * u * 0.25;
        const uu = u / tip;
        const taper = Math.sqrt(Math.max(0, 1 - uu * uu * uu * uu));
        const shape = Math.abs(v) / (sideW * Math.max(0.01, taper));
        if (Math.abs(u) >= tip || shape >= 1) continue;

        const edge = Math.min(1, (1 - shape) * 35);
        const bristle = richness * 0.018 * Math.sin(v * (8 + profile * 12) + phase + u * 0.3);
        const lip = 0.12 * Math.exp(-(((shape - 0.89) * 15) ** 2));
        const mound = depth * (0.7 + bristle + lip + 0.08 * u) * edge;
        const i = y * width + x;
        const paintEdge = edge * relief(spread(x, y));

        // same-colour passes merge; different colours sit on top of each other
        const dr = pigment[0] - image[i * 4], dg = pigment[1] - image[i * 4 + 1], db = pigment[2] - image[i * 4 + 2];
        const separation = Math.min(1, Math.sqrt((dr * dr + dg * dg + db * db) / 3) / 55);
        const deposit = height[i] * (1 - separation) + (0.15 * height[i] + mound) * separation;
        height[i] = height[i] * (1 - paintEdge) + deposit * paintEdge;
        for (let ch = 0; ch < 3; ch++)
          image[i * 4 + ch] = image[i * 4 + ch] * (1 - paintEdge) + pigment[ch] * paintEdge;
      }
  }
  lap("strokes");

  // ---- lighting: blur the height map (colours stay sharp), then shade it
  const r = Math.max(1, Math.round(unit));
  const blurred = new Float32Array(height.length);
  const blur = (src, dst, dx, dy) => {
    for (let y = 0; y < width; y++)
      for (let x = 0; x < width; x++) {
        let value = 0, weight = 0;
        for (let d = -r; d <= r; d++) {
          const w = r + 1 - Math.abs(d);
          const sx = clamp(x + d * dx, 0, width - 1), sy = clamp(y + d * dy, 0, width - 1);
          value += src[sy * width + sx] * w;
          weight += w;
        }
        dst[y * width + x] = value / weight;
      }
  };
  blur(height, blurred, 1, 0);
  blur(blurred, height, 0, 1);

  const L = [-0.45, -0.55, 0.705], H = [-0.243, -0.297, 0.923];
  for (let y = 1; y < width - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = (height[i + 1] - height[i - 1]) / 2;
      const gy = (height[i + width] - height[i - width]) / 2;
      const len = Math.hypot(gx, gy, 1);
      const nx = -gx / len, ny = -gy / len, nz = 1 / len;
      const diffuse = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const shine = Math.pow(Math.max(0, nx * H[0] + ny * H[1] + nz * H[2]), 34) * 0.16;
      let occlusion = 0;
      for (const dist of [2, 4, 7]) {
        const dx = Math.round(dist * unit * 0.63), dy = Math.round(dist * unit * 0.77);
        const upstream = height[Math.max(0, y - dy) * width + Math.max(0, x - dx)];
        occlusion = Math.max(
          occlusion,
          clamp((upstream - height[i] - dist * unit * 0.65) / (2 * unit), 0, 1),
        );
      }
      const shade = (0.52 + 0.6 * diffuse) * (1 - 0.25 * occlusion);
      for (let ch = 0; ch < 3; ch++) {
        const value = image[i * 4 + ch];
        image[i * 4 + ch] = Math.min(255, value * shade + (255 - value * 0.4) * shine);
      }
    }
  lap("lighting");

  return { pixels: image, width, times, ms: Math.round(performance.now() - started) };
}
