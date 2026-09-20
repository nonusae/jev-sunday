// Gallery + prompt UI. Asks the local server for Jev's distributions, then
// paints them in a worker so the page stays responsive.
const SIZES = [8, 12, 16, 24, 32];
const $ = (id) => document.getElementById(id);
const cards = [];
let selected = 0, busy = false, worker = null, jobId = 0;
const jobs = new Map();

const status = (message = "") => ($("status").textContent = message);

function sidebar(open) {
  $("sidebar").hidden = !open;
  $("toggle").setAttribute("aria-expanded", String(open));
}

function navigate(index) {
  selected = Math.max(0, Math.min(cards.length - 1, index));
  const children = [...$("track").children];
  children.forEach((card, i) => card.classList.toggle("active", i === selected));
  const card = children[selected];
  if (!card) return;
  const gap = parseFloat(getComputedStyle($("track")).gap);
  $("track").style.transform = `translateX(${-selected * (card.offsetWidth + gap)}px)`;
  $("position").textContent = `${selected + 1} / ${cards.length}`;
  $("previous").disabled = selected === 0;
  $("next").disabled = selected === cards.length - 1;
  $("navigation").hidden = cards.length < 2;
  showMeta(card);
}

function showMeta(card) {
  const meta = $("meta");
  if (!card?.dataset.model) return (meta.hidden = true);
  meta.hidden = false;
  meta.innerHTML = [
    ["Model", card.dataset.model],
    ["Requests", card.dataset.batches],
    ["Input tokens", Number(card.dataset.tokens).toLocaleString()],
    ["Jev time", `${card.dataset.jevMs} ms`],
    ["Paint time", `${card.dataset.renderMs} ms`],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join("");
}

function begin() {
  const card = document.createElement("div");
  card.className = "art-card active loading";
  card.setAttribute("aria-label", "Generating painting");
  card.innerHTML =
    '<div class="canvas-bottom" aria-hidden="true"></div><div class="loading-wash" aria-hidden="true"></div>';
  if (!cards.length) $("track").replaceChildren(card);
  else $("track").append(card);
  cards.push(card);
  navigate(cards.length - 1);
  $("carousel").setAttribute("aria-busy", "true");
  return card;
}

function render(result) {
  if (!worker) {
    worker = new Worker(new URL("./paint-worker.mjs", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const pending = jobs.get(data.id);
      jobs.delete(data.id);
      if (!pending) return data.bitmap?.close();
      data.error ? pending.reject(new Error(data.error)) : pending.resolve(data);
    };
    worker.onerror = () => {
      for (const p of jobs.values()) p.reject(new Error("Could not start the painting renderer."));
      jobs.clear();
      worker.terminate();
      worker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    jobs.set(id, { resolve, reject });
    worker.postMessage({ id, result });
  });
}

async function paint(result, card) {
  const { bitmap, ms } = await render(result);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = bitmap.width;
  canvas.setAttribute("aria-label", result.prompt);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  Object.assign(card.dataset, {
    model: result.model ?? "jev",
    batches: result.batches,
    tokens: result.usage?.input_tokens ?? 0,
    jevMs: result.ms,
    renderMs: ms,
  });
  card.querySelector(".loading-wash")?.remove();
  card.append(canvas);
  card.classList.remove("loading");
  card.setAttribute("aria-label", result.prompt);
  showMeta(card);
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
    canvas.animate(
      [{ opacity: 0, filter: "blur(10px)" }, { opacity: 1, filter: "blur(0px)" }],
      { duration: 550, easing: "ease-out" },
    );
}

async function askJev(prompt, method, size) {
  const response = await fetch("/api/paint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, method, size }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  return data;
}

$("promptForm").onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  const prompt = $("prompt").value.trim();
  if (!prompt) return;
  busy = true;
  $("generate").disabled = true;
  status();
  const card = begin();
  try {
    const result = await askJev(prompt, $("method").value, Number($("size").value));
    await paint(result, card);
  } catch (error) {
    card.remove();
    cards.pop();
    if (cards.length) navigate(cards.length - 1);
    else {
      $("track").innerHTML = '<div class="art-card active blank"><div class="canvas-bottom"></div></div>';
      $("track").style.transform = "";
      $("navigation").hidden = true;
    }
    status(error.message);
  } finally {
    busy = false;
    $("generate").disabled = false;
    $("carousel").setAttribute("aria-busy", "false");
  }
};

$("size").replaceChildren(...SIZES.map((s) => new Option(`${s} × ${s}`, s)));
$("size").value = "24";
$("previous").onclick = () => navigate(selected - 1);
$("next").onclick = () => navigate(selected + 1);
$("toggle").onclick = () => sidebar($("sidebar").hidden);
$("close").onclick = () => sidebar(false);
$("prompt").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("promptForm").requestSubmit();
  }
};
window.addEventListener("resize", () => cards.length && navigate(selected));
document.addEventListener("keydown", (e) => e.key === "Escape" && !$("sidebar").hidden && sidebar(false));
