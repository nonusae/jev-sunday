#!/usr/bin/env node
// Render a recorded fixture (or a saved /api/paint response) to out/<name>.png
// without a browser. Usage: node scripts/preview.mjs [file.json] [width]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";
import { renderPaint } from "../web/renderer.mjs";

const file = process.argv[2] ?? "tests/fixtures/palette.json";
const width = Number(process.argv[3]) || 560;
const data = JSON.parse(await readFile(file, "utf8"));
const { pixels, times, ms } = renderPaint(data, width);

// PPM is trivial to write; convert to PNG with sips (macOS) or ImageMagick if present.
const rgb = Buffer.alloc(width * width * 3);
for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
  rgb[j] = pixels[i]; rgb[j + 1] = pixels[i + 1]; rgb[j + 2] = pixels[i + 2];
}
await mkdir("out", { recursive: true });
const name = basename(file).replace(/\.json$/, "");
const ppm = `out/${name}.ppm`;
await writeFile(ppm, Buffer.concat([Buffer.from(`P6\n${width} ${width}\n255\n`), rgb]));
let png = null;
for (const cmd of [["sips", "-s", "format", "png", ppm, "--out", `out/${name}.png`], ["magick", ppm, `out/${name}.png`]]) {
  try { execFileSync(cmd[0], cmd.slice(1), { stdio: "ignore" }); png = `out/${name}.png`; break; } catch {}
}
console.log(`${data.method} ${data.size}×${data.size} "${data.prompt ?? ""}" → ${png ?? ppm}`);
console.log(`render ${ms} ms`, times);
