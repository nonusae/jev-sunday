// Probability -> colour maths. Pure functions, no DOM, so tests run in Node.

export function normalized(p) {
  const sum = p.reduce((a, b) => a + b, 0);
  if (!sum || p.some((x) => !Number.isFinite(x) || x < 0))
    throw new Error("Invalid distribution");
  return p.map((x) => x / sum);
}
export const argmax = (p) => p.indexOf(Math.max(...p));

export function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}
// neutral, red, orange, yellow, green, cyan, blue, purple, magenta
const HUE_ANGLES = [0, 0, 1 / 12, 1 / 6, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 5 / 6];

// Expand one pixel's answer(s) into a categorical distribution over concrete
// RGB colours. Multi-question representations (HSL, RGB) are combined assuming
// independence, because Jev answers each question separately.
function expand(method, p, palette) {
  if (method === "palette") {
    const weights = normalized(p.probabilities);
    return { colors: palette, weights, hard: palette[argmax(weights)] };
  }
  if (method === "silhouette") {
    const colors = [[255, 255, 255], [0, 0, 0]];
    return {
      colors,
      weights: [1 - p.foreground, p.foreground],
      hard: colors[p.foreground >= 0.5 ? 1 : 0],
    };
  }
  if (method === "rgb") {
    const colors = [], weights = [];
    for (let bits = 0; bits < 8; bits++) {
      const color = [], w = [0, 1, 2].reduce((acc, c) => {
        const on = (bits >> c) & 1;
        color.push(on * 255);
        return acc * (on ? p.channels[c] : 1 - p.channels[c]);
      }, 1);
      colors.push(color);
      weights.push(w);
    }
    return { colors, weights, hard: p.channels.map((v) => (v >= 0.5 ? 255 : 0)) };
  }
  // hsl
  const hp = normalized(p.hue), sp = normalized(p.saturation), lp = normalized(p.lightness);
  const colors = [], weights = [];
  for (let h = 0; h < hp.length; h++)
    for (let s = 0; s < sp.length; s++)
      for (let l = 0; l < lp.length; l++) {
        colors.push(hsl(HUE_ANGLES[h], h === 0 ? 0 : s / (sp.length - 1), l / (lp.length - 1)));
        weights.push(hp[h] * sp[s] * lp[l]);
      }
  const hi = argmax(hp);
  const hard = hsl(
    HUE_ANGLES[hi],
    hi === 0 ? 0 : argmax(sp) / (sp.length - 1),
    argmax(lp) / (lp.length - 1),
  );
  return { colors, weights, hard };
}

// Per pixel: candidate colours, normalised weights, the mean colour (what a
// "blurry average" of Jev's belief looks like) and the argmax colour.
export function prepare(data) {
  const pixels = data.pixels.map((p) => {
    const e = expand(data.method, p, data.palette);
    const weights = normalized(e.weights);
    const mean = [0, 1, 2].map((c) =>
      e.colors.reduce((sum, color, i) => sum + color[c] * weights[i], 0),
    );
    return { colors: e.colors, weights, mean, hard: e.hard };
  });
  return {
    size: data.size,
    pixels,
    mean: pixels.flatMap((p) => p.mean),
    hard: pixels.flatMap((p) => p.hard),
  };
}
