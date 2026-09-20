// "Jev's working": the right-hand panel that shows what was sent to Jev (the
// state and the typed questions), what came back per pixel (the distribution,
// Jev's reported choice/score and confidence), and how the renderer turns that
// into a decision and into brushwork. Reads the same src/questions.mjs the
// server uses, so the question text shown is exactly what Jev was asked.
import {
  buildState, pixelQuestions, QUESTIONS_PER_BATCH,
  PALETTE_NAMES, HUES, SATURATION_LEVELS, LIGHTNESS_LEVELS, CHANNELS,
} from "/src/questions.mjs";
import { prepare, argmax } from "./art.mjs";

const PRIMITIVES = {
  palette: ["Choice over 16 named colours"],
  silhouette: ["Noul: is the pixel inside the subject?"],
  rgb: ["Noul: red ON?", "Noul: green ON?", "Noul: blue ON?"],
  hsl: ["Choice over 9 hues", "Score: saturation (3 levels)", "Score: lightness (5 levels)"],
};
const LABELS = {
  palette: [PALETTE_NAMES],
  silhouette: [["no", "yes"]],
  rgb: [["off", "on"], ["off", "on"], ["off", "on"]],
  hsl: [HUES, SATURATION_LEVELS.map((s) => s.split(",")[0]), LIGHTNESS_LEVELS.map((s) => s.split(",")[0])],
};
// Brushwork thresholds from renderer.mjs: no relief below 0.48, full above 0.80.
const RELIEF_START = 0.48, RELIEF_FULL = 0.8;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (v) => `${Math.round(v * 100)}%`;
const rgb = (c) => `rgb(${c.map(Math.round).join(",")})`;
const spreadOf = (weights) => 1 - Math.exp(-weights.reduce((h, p) => (p > 0 ? h - p * Math.log(p) : h), 0));

// One pixel's answers as a list of { label, question, answer, confidence, bars }.
function answersFor(result, i) {
  const p = result.pixels[i];
  const x = i % result.size, y = Math.floor(i / result.size);
  const questions = Object.values(pixelQuestions(result.method, x, y));
  const labels = LABELS[result.method];
  const dists =
    result.method === "palette" ? [p.probabilities]
    : result.method === "silhouette" ? [[1 - p.foreground, p.foreground]]
    : result.method === "rgb" ? p.channels.map((c) => [1 - c, c])
    : [p.hue, p.saturation, p.lightness];
  const reported =
    result.method === "palette" ? [p.reported]
    : result.method === "hsl" ? [p.reported?.hue, p.reported?.saturation, p.reported?.lightness]
    : [];
  return questions.map((q, k) => {
    const d = dists[k], r = reported[k] ?? {};
    let answer;
    if (q.type === "noul") answer = `p(yes) = ${d[1].toFixed(2)} → ${d[1] >= 0.5 ? "yes" : "no"}`;
    else if (q.type === "choice") answer = r.choice ?? `${labels[k][argmax(d)]} (top probability)`;
    else if (typeof r.score === "number")
      answer = `score ${r.score.toFixed(2)} → nearest "${labels[k][Math.max(0, Math.min(labels[k].length - 1, Math.round(r.score)))]}"`;
    else answer = `${labels[k][argmax(d)]} (top probability)`;
    return {
      primitive: q.type,
      question: q.instructions,
      answer,
      confidence: r.confidence,
      bars: labels[k].map((label, j) => ({ label, p: d[j], colour: result.method === "palette" ? result.palette[j] : null })),
    };
  });
}

export function createWorkingPanel({ body, onInspect }) {
  let result = null, prepared = null, spreads = null, pinned = null, hovered = null;
  const grids = { decision: null, spread: null };

  const section = (title, html) => `<section class="w-section"><h3>${title}</h3>${html}</section>`;

  const stateHtml = (state, pending) =>
    section("State sent with every request", `${pending ? '<p class="w-pending">Waiting for Jev…</p>' : ""}<details class="w-details"${pending ? " open" : ""}><summary>Show the state object</summary><pre class="w-state">${esc(JSON.stringify(state, null, 2))}</pre></details>`);

  const questionsHtml = ({ method, size, batches, model, usage }) => {
    const per = PRIMITIVES[method];
    const total = size * size * per.length;
    const perBatch = QUESTIONS_PER_BATCH[method];
    const count = batches ?? Math.ceil(total / perBatch);
    return section("Questions", `
      <p class="w-line">Per pixel: ${per.map((t) => `<span class="w-chip">${esc(t)}</span>`).join(" ")}</p>
      <dl class="w-kv">
        <dt>Pixels</dt><dd>${size} × ${size} = ${(size * size).toLocaleString()}</dd>
        <dt>Questions</dt><dd>${total.toLocaleString()}</dd>
        <dt>Requests</dt><dd>${count} × up to ${perBatch.toLocaleString()}</dd>
        ${model ? `<dt>Model</dt><dd>${esc(model)}</dd>` : ""}
        ${usage ? `<dt>Input tokens</dt><dd>${usage.input_tokens.toLocaleString()}</dd>` : ""}
      </dl>
      <p class="w-note">Every request carries the same state, so each batch sees the whole composition. Jev answers all questions in a request in parallel and cannot see other batches.</p>`);
  };

  const summaryHtml = () => {
    const n = prepared.pixels.length;
    const brushed = spreads.filter((s) => s > RELIEF_START).length;
    const heavy = spreads.filter((s) => s >= RELIEF_FULL).length;
    const confs = result.pixels.flatMap((p) =>
      result.method === "palette" ? [p.reported?.confidence]
      : result.method === "hsl" ? [p.reported?.hue?.confidence, p.reported?.saturation?.confidence, p.reported?.lightness?.confidence]
      : []).filter((c) => typeof c === "number");
    const meanConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
    const sure = confs.filter((c) => c >= 0.8).length;
    const worst = spreads.indexOf(Math.max(...spreads));
    return section("How it decides", `
      <div class="w-grids">
        <figure><canvas id="wDecision" width="${result.size}" height="${result.size}"></canvas><figcaption>Decision: top colour per pixel</figcaption></figure>
        <figure><canvas id="wSpread" width="${result.size}" height="${result.size}"></canvas><figcaption>Spread: entropy of each pixel's colours</figcaption></figure>
      </div>
      <dl class="w-kv">
        ${meanConf === null ? "<dt>Reported confidence</dt><dd>not reported for Noul answers</dd>" : `<dt>Mean reported confidence</dt><dd>${meanConf.toFixed(2)}</dd><dt>Answers ≥ 0.80 confident</dt><dd>${pct(sure / confs.length)}</dd>`}
        <dt>Pixels that get brushwork</dt><dd>${pct(brushed / n)}</dd>
        <dt>Pixels with full impasto</dt><dd>${pct(heavy / n)}</dd>
        <dt>Most uncertain pixel</dt><dd><button class="w-link" data-pixel="${worst}">(x=${worst % result.size}, y=${Math.floor(worst / result.size)})</button></dd>
      </dl>
      <p class="w-note">The renderer paints the mean colour where spread is low and lays visible strokes where spread is above ${RELIEF_START} (full relief at ${RELIEF_FULL}). Spread is computed here from the distribution; reported confidence is Jev's own number and the two need not agree.</p>`);
  };

  const pixelHtml = (i) => {
    const x = i % result.size, y = Math.floor(i / result.size);
    const px = prepared.pixels[i];
    const rows = answersFor(result, i).map((a) => `
      <div class="w-answer">
        <p class="w-q"><span class="w-type">${a.primitive}</span> ${esc(a.question)}</p>
        <p class="w-a">Jev says <strong>${esc(a.answer)}</strong>${typeof a.confidence === "number" ? ` · confidence <strong>${a.confidence.toFixed(2)}</strong>` : ""}</p>
        <ul class="w-bars">${a.bars.filter((b) => b.p >= 0.005 || a.bars.length <= 5).sort((u, v) => v.p - u.p).slice(0, 8).map((b) => `
          <li><span class="w-label">${b.colour ? `<i style="background:${rgb(b.colour)}"></i>` : ""}${esc(b.label)}</span><span class="w-bar"><span style="width:${pct(b.p)}"></span></span><span class="w-p">${pct(b.p)}</span></li>`).join("")}
        </ul>
      </div>`).join("");
    return section(`Pixel (x=${x}, y=${y}) <span class="w-hint">${pinned === i ? "pinned · click painting to unpin" : "hover the painting · click to pin"}</span>`, `
      ${rows}
      <dl class="w-kv w-painted">
        <dt>Top colour</dt><dd><i class="w-swatch" style="background:${rgb(px.hard)}"></i></dd>
        <dt>Mean colour (underpainting)</dt><dd><i class="w-swatch" style="background:${rgb(px.mean)}"></i></dd>
        <dt>Spread</dt><dd>${spreads[i].toFixed(2)} → ${spreads[i] < RELIEF_START ? "smooth" : spreads[i] < RELIEF_FULL ? "some strokes" : "full impasto"}</dd>
      </dl>`);
  };

  function drawGrids() {
    const n = result.size;
    const dec = body.querySelector("#wDecision"), spr = body.querySelector("#wSpread");
    if (!dec || !spr) return;
    const d = dec.getContext("2d"), s = spr.getContext("2d");
    const di = d.createImageData(n, n), si = s.createImageData(n, n);
    prepared.pixels.forEach((p, i) => {
      di.data.set([...p.hard.map(Math.round), 255], i * 4);
      const t = spreads[i];
      // pale parchment → deep plum, matching the studio palette
      si.data.set([Math.round(250 - 190 * t), Math.round(246 - 200 * t), Math.round(240 - 150 * t), 255], i * 4);
    });
    d.putImageData(di, 0, 0);
    s.putImageData(si, 0, 0);
    grids.decision = dec; grids.spread = spr;
    for (const c of [dec, spr]) {
      c.onmousemove = (e) => onInspect?.(pixelAt(c, e), false);
      c.onmouseleave = () => onInspect?.(null, false);
      c.onclick = (e) => onInspect?.(pixelAt(c, e), true);
    }
  }

  function pixelAt(el, e) {
    const r = el.getBoundingClientRect();
    const x = Math.min(result.size - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * result.size)));
    const y = Math.min(result.size - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * result.size)));
    return y * result.size + x;
  }

  function markCursor() {
    const i = hovered ?? pinned;
    body.querySelector(".w-cursor")?.remove();
    if (i === null || !grids.decision) return;
    for (const c of [grids.decision, grids.spread]) {
      const fig = c.parentElement;
      fig.querySelectorAll(".w-cursor").forEach((el) => el.remove());
      const m = document.createElement("span");
      m.className = "w-cursor";
      const cell = 100 / result.size;
      m.style.cssText = `left:${(i % result.size) * cell}%;top:${Math.floor(i / result.size) * cell}%;width:${cell}%;height:${cell}%`;
      fig.append(m);
    }
  }

  function renderPixel() {
    const i = hovered ?? pinned;
    const slot = body.querySelector("#wPixel");
    if (!slot) return;
    slot.innerHTML = i === null ? "" : pixelHtml(i);
    markCursor();
  }

  return {
    // A painting is being requested: show what is about to be sent.
    pending({ prompt, method, size }) {
      result = prepared = spreads = null; pinned = hovered = null;
      body.innerHTML = questionsHtml({ method, size }) + stateHtml(buildState(prompt, method, size), true);
    },
    // A finished painting is selected.
    show(next) {
      if (!next) { result = null; body.innerHTML = '<p class="w-empty">Paint something and Jev’s state, questions, answers and confidence will appear here.</p>'; return; }
      if (next === result) return;
      result = next; hovered = null;
      prepared = prepare(result);
      spreads = prepared.pixels.map((p) => spreadOf(p.weights));
      pinned = spreads.indexOf(Math.max(...spreads));
      body.innerHTML =
        summaryHtml() + '<div id="wPixel"></div>' + questionsHtml(result) +
        stateHtml(result.state ?? buildState(result.prompt, result.method, result.size));
      body.parentElement.scrollTop = 0;
      drawGrids();
      renderPixel();
      body.querySelectorAll("[data-pixel]").forEach((b) => (b.onclick = () => { pinned = Number(b.dataset.pixel); renderPixel(); }));
    },
    hover(i) { if (!result) return; hovered = i; renderPixel(); },
    pin(i) { if (!result) return; pinned = pinned === i ? null : i; hovered = null; renderPixel(); },
    get result() { return result; },
  };
}
