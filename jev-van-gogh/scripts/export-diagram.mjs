#!/usr/bin/env node
// Export the diagram inside an Archify HTML file as a PNG for the README.
// Usage: node scripts/export-diagram.mjs docs/system-architecture.html [docs/system-architecture.png] [light|dark]
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const [input, output = input.replace(/\.html$/, ".png"), theme = "light"] = process.argv.slice(2);
if (!input) throw new Error("Usage: export-diagram.mjs <archify.html> [out.png] [light|dark]");
const html = await readFile(input, "utf8");

const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
const start = html.search(/<svg[^>]*\brole="img"/);
if (start < 0) throw new Error("No diagram <svg role=\"img\"> found.");
let depth = 0, i = start, end = -1;
const tag = /<\/?svg\b[^>]*>/g;
tag.lastIndex = start;
for (let m; (m = tag.exec(html)); ) {
  depth += m[0].startsWith("</") ? -1 : 1;
  if (depth === 0) { end = m.index + m[0].length; break; }
}
const svg = html.slice(start, end);
const [, w, h] = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);

const page = `<!doctype html><html lang="en" data-theme="${theme}" data-preset="classic"><head><meta charset="utf-8"><style>${styles}
html,body{margin:0;padding:0;overflow:hidden}
body{width:${w}px;height:${h}px;background:${theme === "dark" ? "#0b1220" : "#ffffff"}}
svg{display:block;width:${w}px;height:${h}px}</style></head><body>${svg}</body></html>`;

const dir = await mkdtemp(join(tmpdir(), "archify-export-"));
const file = join(dir, "diagram.html");
await writeFile(file, page);
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
execFileSync(chrome, [
  "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=2",
  `--window-size=${w},${h}`, `--screenshot=${resolve(output)}`, `file://${file}`,
], { stdio: "ignore" });
await rm(dir, { recursive: true, force: true });
console.log(`${input} → ${output} (${w}×${h} @2x, ${theme})`);
