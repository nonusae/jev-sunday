// Server-side bridge to Jev through the official SDK. The SDK refuses to run in
// a browser (it would expose the API key), so the browser talks to server.mjs,
// and this module talks to TypeSafe.
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { buildRequests, pack } from "./questions.mjs";

let shared;
export function defaultClient() {
  shared ??= new TypeSafeClient({ timeoutMs: 150_000 });
  return shared;
}

// Independent batches run concurrently. They cannot see one another's answers,
// which is fine: each pixel question is judged only against the shared state.
export async function generate(
  { prompt, method, size },
  { client = defaultClient(), concurrency = 4, onBatch } = {},
) {
  const { state, batches, prompt: text } = buildRequests(prompt, method, size);
  const answers = {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  let model = null;
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < batches.length) {
      const questions = batches[next++];
      const result = await client.systemOne({ state, questions, model: "jev-latest" });
      Object.assign(answers, result.answers);
      usage.input_tokens += result.usage?.input_tokens ?? 0;
      usage.output_tokens += result.usage?.output_tokens ?? 0;
      model ??= result.model;
      onBatch?.(++done, batches.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, worker),
  );
  return { ...pack(answers, method, size, text), model, usage, batches: batches.length };
}
