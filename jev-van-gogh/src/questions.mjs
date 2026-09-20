// Every pixel of the image becomes one or more typed Jev questions.
// Jev never generates an image: it answers "what colour is pixel (x, y)?"
// with a probability distribution, and the renderer paints those distributions.

export const PALETTE = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  red: [220, 40, 40],
  orange: [255, 150, 40],
  pink: [255, 170, 190],
  brown: [125, 70, 35],
  tan: [205, 160, 105],
  green: [65, 165, 65],
  dark_green: [25, 90, 35],
  blue: [45, 90, 210],
  sky_blue: [170, 220, 255],
  yellow: [255, 215, 40],
  purple: [110, 45, 160],
  navy: [15, 20, 50],
  cream: [255, 240, 205],
};
export const PALETTE_NAMES = Object.keys(PALETTE);

export const HUES = [
  "neutral",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "magenta",
];
export const SATURATION_LEVELS = [
  "Achromatic gray, zero saturation",
  "Muted or pastel, half saturation",
  "Pure vivid color, full saturation",
];
export const LIGHTNESS_LEVELS = [
  "Black, lightness 0",
  "Dark, lightness 0.25",
  "Middle lightness 0.5",
  "Light, lightness 0.75",
  "White, lightness 1",
];
export const CHANNELS = ["red", "green", "blue"];

export const METHODS = ["palette", "hsl", "rgb", "silhouette"];
export const SIZES = [8, 12, 16, 24, 32];

// Questions per request. Jev evaluates every question in a request against the
// same state in parallel, so bigger batches mean fewer round trips, bounded by
// the 64k-token request budget.
const QUESTIONS_PER_BATCH = {
  palette: 144,
  hsl: 144 * 3,
  rgb: 256 * 3,
  silhouette: 1024,
};

const pixelKey = (x, y) => `x${x}_y${y}`;
const nullCriteria = (labels) =>
  Object.fromEntries(labels.map((label) => [label, null]));

// The state is the shared context every question is judged against: the
// prompt, the canvas, and the coordinate convention the questions use.
export function buildState(prompt, method, size) {
  const state = {
    image_description: prompt,
    width: size,
    height: size,
    coordinates:
      "Origin (0,0) is the top-left pixel. x increases to the right, y increases downward.",
    task: "Compose one coherent, recognizable pixel-art image of the description. Fill the whole canvas including the background. No text, no border.",
  };
  if (method === "silhouette")
    state.task =
      "Compose a recognizable black silhouette of the subject on a white background. Fit the subject with a small margin. No scenery, shadow, text or border.";
  if (method === "rgb")
    state.task +=
      " Each RGB channel is either OFF (0) or ON (255). Together they select black, red, green, blue, yellow, cyan, magenta or white. Choose the closest available colour.";
  return state;
}

// One pixel -> its questions. Each primitive is chosen by what the answer means:
//   Choice  : one colour out of a fixed set (palette, hue)
//   Noul    : whether a condition holds (channel on, inside silhouette)
//   Score   : a degree along an ordered scale (saturation, lightness)
export function pixelQuestions(method, x, y) {
  const key = pixelKey(x, y);
  const at = `pixel (x=${x}, y=${y})`;
  switch (method) {
    case "palette":
      return {
        [key]: {
          type: "choice",
          instructions: `What colour is ${at} in the described image?`,
          criteria: nullCriteria(PALETTE_NAMES),
        },
      };
    case "silhouette":
      return {
        [key]: {
          type: "noul",
          instructions: `Is ${at} inside the foreground silhouette of the subject described in the state?`,
          criteria: {
            true: "The pixel is part of the subject and painted black.",
            false: "The pixel is background and stays white.",
          },
        },
      };
    case "rgb":
      return Object.fromEntries(
        CHANNELS.map((channel) => [
          `${key}_${channel}`,
          {
            type: "noul",
            instructions: `Should the ${channel} channel be ON at ${at} in the described image?`,
          },
        ]),
      );
    case "hsl":
      return {
        [`${key}_hue`]: {
          type: "choice",
          instructions: `What is the hue at ${at}? Ignore brightness. Choose neutral for white, gray or black.`,
          criteria: nullCriteria(HUES),
        },
        [`${key}_saturation`]: {
          type: "score",
          instructions: `How saturated is the colour at ${at}?`,
          criteria: SATURATION_LEVELS,
        },
        [`${key}_lightness`]: {
          type: "score",
          instructions: `What is the HSL lightness at ${at}?`,
          criteria: LIGHTNESS_LEVELS,
        },
      };
    default:
      throw new Error(`Unknown representation: ${method}`);
  }
}

// Whole grid -> a state plus a list of question batches. Every batch shares the
// same state so each request still sees the full composition and coordinates.
export function buildRequests(prompt, method, size) {
  if (!METHODS.includes(method) || !SIZES.includes(size))
    throw new Error("Unsupported representation or grid size.");
  const text = String(prompt ?? "").trim();
  if (!text || text.length > 2000)
    throw new Error("Enter a prompt of up to 2,000 characters.");

  const state = buildState(text, method, size);
  const entries = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      entries.push(...Object.entries(pixelQuestions(method, x, y)));

  const per = QUESTIONS_PER_BATCH[method];
  const batches = [];
  for (let i = 0; i < entries.length; i += per)
    batches.push(Object.fromEntries(entries.slice(i, i + per)));
  return { state, batches, prompt: text };
}

// ---- answers -> per-pixel distributions ----------------------------------

function probability(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("Jev returned an invalid probability.");
  return value;
}
function distribution(answer, labels) {
  if (!answer?.probabilities)
    throw new Error("Jev returned an incomplete distribution.");
  const p = labels.map((label) => probability(answer.probabilities[label] ?? 0));
  const sum = p.reduce((a, b) => a + b, 0);
  if (!sum) throw new Error("Jev returned an empty distribution.");
  return p.map((v) => v / sum);
}

// Pack raw answers into the compact, renderer-facing shape. Nothing here is
// collapsed to a single colour: the full distribution is what gets painted.
export function pack(answers, method, size, prompt) {
  const pixels = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const key = pixelKey(x, y);
      if (method === "palette")
        pixels.push({ probabilities: distribution(answers[key], PALETTE_NAMES) });
      else if (method === "silhouette")
        pixels.push({ foreground: probability(answers[key]?.noul) });
      else if (method === "rgb")
        pixels.push({
          channels: CHANNELS.map((c) => probability(answers[`${key}_${c}`]?.noul)),
        });
      else
        pixels.push({
          hue: distribution(answers[`${key}_hue`], HUES),
          saturation: distribution(
            answers[`${key}_saturation`],
            SATURATION_LEVELS.map((_, i) => String(i)),
          ),
          lightness: distribution(
            answers[`${key}_lightness`],
            LIGHTNESS_LEVELS.map((_, i) => String(i)),
          ),
        });
    }
  return { method, size, prompt, pixels, palette: Object.values(PALETTE) };
}
