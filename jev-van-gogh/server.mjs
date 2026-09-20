#!/usr/bin/env node
// Local studio: serves web/ and exposes POST /api/paint, which asks Jev for the
// per-pixel distributions. The API key never leaves this process.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { APIError } from "@typesafe-ai/sdk";
import { generate } from "./src/jev.mjs";
import { METHODS, SIZES } from "./src/questions.mjs";

const WEB = fileURLToPath(new URL("./web/", import.meta.url));
// Pure modules the browser may import so the working panel can show the exact
// state and question text that src/ builds, without duplicating it in web/.
const SHARED = {
  "/src/questions.mjs": fileURLToPath(new URL("./src/questions.mjs", import.meta.url)),
};
const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8791;
const hasKey = Boolean(process.env.TYPESAFE_API_KEY);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const send = (res, status, body, type = "application/json") => {
  const payload = type.startsWith("application/json") ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
};

async function readJson(req, limit = 16_384) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function serveStatic(res, url) {
  const path = normalize(url === "/" ? "/index.html" : url).replace(/^(\.\.[/\\])+/, "");
  const file = SHARED[path] ?? join(WEB, path);
  if (!SHARED[path] && !file.startsWith(WEB)) return send(res, 403, { error: "Forbidden" });
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    send(res, 200, await readFile(file), types[extname(file)] || "application/octet-stream");
  } catch {
    send(res, 404, { error: "Not found" });
  }
}

async function paint(req, res) {
  if (!hasKey)
    return send(res, 503, {
      error: "TYPESAFE_API_KEY is not set. Export it and restart the server.",
    });
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return send(res, 400, { error: error.message });
  }
  const { prompt, method, size } = body;
  if (!METHODS.includes(method) || !SIZES.includes(Number(size)))
    return send(res, 400, { error: "Unsupported representation or grid size." });
  try {
    const started = performance.now();
    const result = await generate({ prompt, method, size: Number(size) });
    result.ms = Math.round(performance.now() - started);
    send(res, 200, result);
  } catch (error) {
    if (error instanceof APIError) {
      const messages = {
        401: "Jev rejected the API key.",
        403: "Jev denied access for this key.",
        413: "Request is too large. Try a smaller grid.",
        422: "Jev rejected the question set (validation error).",
        429: "Jev is rate limiting requests. Try again shortly.",
        529: "Jev is overloaded. Try again shortly.",
      };
      return send(res, 502, {
        error: messages[error.status] || `Jev request failed (HTTP ${error.status}).`,
      });
    }
    send(res, error.message?.startsWith("Enter a prompt") ? 400 : 500, {
      error: error.message || "Painting failed.",
    });
  }
}

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === "POST" && url.pathname === "/api/paint") return paint(req, res);
  if (req.method === "GET") return serveStatic(res, url.pathname);
  send(res, 405, { error: "Method not allowed" });
}).listen(port, "127.0.0.1", () => {
  console.log(`jev-van-gogh  →  http://127.0.0.1:${port}`);
  console.log(
    hasKey
      ? "TYPESAFE_API_KEY found. Enter a prompt and paint."
      : "TYPESAFE_API_KEY is not set: the page will load but painting will fail.",
  );
});
