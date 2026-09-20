import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepare, hsl, normalized } from "../web/art.mjs";
import { renderPaint } from "../web/renderer.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/palette.json", import.meta.url), "utf8"),
);

test("hsl conversion hits the primaries", () => {
  assert.deepEqual(hsl(0, 1, 0.5).map(Math.round), [255, 0, 0]);
  assert.deepEqual(hsl(1 / 3, 1, 0.5).map(Math.round), [0, 255, 0]);
  assert.deepEqual(hsl(0, 0, 1).map(Math.round), [255, 255, 255]);
});

test("prepare produces a mean colour and hard colour per pixel for every representation", () => {
  const cases = [
    { method: "palette", size: 2, palette: [[0, 0, 0], [255, 255, 255]], pixels: Array(4).fill({ probabilities: [0.25, 0.75] }) },
    { method: "silhouette", size: 2, pixels: Array(4).fill({ foreground: 0.9 }) },
    { method: "rgb", size: 2, pixels: Array(4).fill({ channels: [1, 0, 0.5] }) },
    { method: "hsl", size: 2, pixels: Array(4).fill({ hue: normalized([0, 1, 0, 0, 0, 0, 0, 0, 0]), saturation: [0, 0, 1], lightness: [0, 0, 1, 0, 0] }) },
  ];
  for (const data of cases) {
    const p = prepare(data);
    assert.equal(p.pixels.length, 4, data.method);
    for (const px of p.pixels) {
      assert.equal(px.mean.length, 3);
      assert.ok(px.mean.every((v) => v >= 0 && v <= 255));
      assert.ok(Math.abs(px.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    }
  }
  const rgb = prepare(cases[2]).pixels[0];
  assert.deepEqual(rgb.hard, [255, 0, 255]);
  assert.deepEqual(rgb.mean.map(Math.round), [255, 0, 128]);
});

test("renderPaint is deterministic and fills the whole canvas", () => {
  const a = renderPaint(fixture, 140);
  const b = renderPaint(fixture, 140);
  assert.equal(a.pixels.length, 140 * 140 * 4);
  assert.deepEqual(a.pixels, b.pixels);
  for (let i = 3; i < a.pixels.length; i += 4) assert.equal(a.pixels[i], 255);
  assert.ok(a.ms >= 0 && Object.keys(a.times).length === 4);
});
