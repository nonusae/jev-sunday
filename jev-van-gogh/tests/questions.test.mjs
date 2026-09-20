import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequests, pack, pixelQuestions, PALETTE_NAMES, HUES, SIZES, METHODS,
} from "../src/questions.mjs";

test("palette: one Choice per pixel with every palette colour as an option", () => {
  const q = pixelQuestions("palette", 3, 5);
  assert.deepEqual(Object.keys(q), ["x3_y5"]);
  assert.equal(q.x3_y5.type, "choice");
  assert.deepEqual(Object.keys(q.x3_y5.criteria), PALETTE_NAMES);
  assert.match(q.x3_y5.instructions, /x=3, y=5/);
});

test("hsl: Choice for hue plus two Scores; rgb: three Nouls; silhouette: one Noul", () => {
  const hsl = pixelQuestions("hsl", 0, 0);
  assert.deepEqual(Object.values(hsl).map((q) => q.type), ["choice", "score", "score"]);
  assert.deepEqual(Object.keys(hsl.x0_y0_hue.criteria), HUES);
  const rgb = pixelQuestions("rgb", 0, 0);
  assert.deepEqual(Object.values(rgb).map((q) => q.type), ["noul", "noul", "noul"]);
  assert.equal(pixelQuestions("silhouette", 0, 0).x0_y0.type, "noul");
});

test("buildRequests batches every question and shares one state", () => {
  for (const method of METHODS)
    for (const size of SIZES) {
      const { state, batches } = buildRequests("a red barn", method, size);
      const perPixel = { palette: 1, silhouette: 1, rgb: 3, hsl: 3 }[method];
      const total = batches.reduce((n, b) => n + Object.keys(b).length, 0);
      assert.equal(total, size * size * perPixel, `${method} ${size}`);
      assert.equal(state.width, size);
      assert.equal(state.image_description, "a red barn");
    }
  const { batches } = buildRequests("x", "palette", 24);
  assert.equal(batches.length, 4); // 576 questions / 144 per batch
});

test("buildRequests rejects bad input", () => {
  assert.throws(() => buildRequests("", "palette", 8), /prompt/);
  assert.throws(() => buildRequests("ok", "oil", 8), /Unsupported/);
  assert.throws(() => buildRequests("ok", "palette", 7), /Unsupported/);
});

test("pack turns answers into normalised per-pixel distributions", () => {
  const answers = {};
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      answers[`x${x}_y${y}`] = {
        type: "choice",
        choice: "red",
        confidence: 0.5,
        probabilities: Object.fromEntries(PALETTE_NAMES.map((n) => [n, n === "red" ? 0.6 : 0.4 / 15])),
      };
  const packed = pack(answers, "palette", 8, "test");
  assert.equal(packed.pixels.length, 64);
  const sum = packed.pixels[0].probabilities.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(packed.palette.length, 16);
  // Jev's own choice and confidence ride along for the working panel.
  assert.deepEqual(packed.pixels[0].reported, { choice: "red", confidence: 0.5 });
});

test("pack keeps reported score/confidence for hsl and none for noul answers", () => {
  const answers = {};
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      answers[`x${x}_y${y}_hue`] = {
        type: "choice", choice: "blue", confidence: 0.7,
        probabilities: Object.fromEntries(HUES.map((h) => [h, h === "blue" ? 0.7 : 0.3 / 8])),
      };
      answers[`x${x}_y${y}_saturation`] = {
        type: "score", score: 1.4, confidence: 0.6, probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 },
      };
      answers[`x${x}_y${y}_lightness`] = {
        type: "score", score: 2, confidence: 0.9, probabilities: { 0: 0, 1: 0.05, 2: 0.9, 3: 0.05, 4: 0 },
      };
    }
  const hsl = pack(answers, "hsl", 8, "test");
  assert.deepEqual(hsl.pixels[0].reported, {
    hue: { choice: "blue", confidence: 0.7 },
    saturation: { score: 1.4, confidence: 0.6 },
    lightness: { score: 2, confidence: 0.9 },
  });
  const noul = {};
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) noul[`x${x}_y${y}`] = { type: "noul", noul: 0.8 };
  assert.equal(pack(noul, "silhouette", 8, "x").pixels[0].reported, undefined);
});

test("pack rejects incomplete or invalid answers", () => {
  assert.throws(() => pack({}, "palette", 8, "x"), /incomplete/);
  assert.throws(() => pack({ x0_y0: { noul: 1.5 } }, "silhouette", 8, "x"), /invalid/);
});
