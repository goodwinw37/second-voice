// Runs the two speech models off the main thread, so audio and the interface stay smooth.
//
//   Moonshine turns audio into text. It was the fastest of the models compared on
//   short phrases (see README), and it doesn't need a graphics chip.
//   MiniLM turns text into vectors, for matching rewordings of known tactics.
//
// Both run on this device. They download from Hugging Face on first use, then the
// browser caches them. Only model files are ever fetched, and no audio is sent.

import { env, pipeline } from "@huggingface/transformers";

const ASR_MODEL = "onnx-community/moonshine-base-ONNX";
const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

env.allowLocalModels = false;
env.backends.onnx!.wasm!.wasmPaths = "/ort/";

export type WorkerRequest =
  | { id: number; type: "load" }
  | { id: number; type: "transcribe"; samples: Float32Array }
  | { id: number; type: "embed"; texts: string[] };

export type WorkerResponse =
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "error"; message: string }
  | { type: "progress"; file: string; loaded: number; total: number };

let transcriber: any = null;
let embedder: any = null;

async function load(): Promise<void> {
  const progress_callback = (event: any) => {
    if (event.status === "progress" && event.total) {
      self.postMessage({ type: "progress", file: event.file, loaded: event.loaded, total: event.total } satisfies WorkerResponse);
    }
  };
  const options = { device: "wasm", progress_callback } as any;
  transcriber = await pipeline("automatic-speech-recognition", ASR_MODEL, {
    ...options,
    dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
  });
  // 16-bit, not 8-bit. The 8-bit model gives slightly different vectors depending on what else is in the batch,
  // and between Node and Chrome, so the evaluation would not be measuring what the app does.
  embedder = await pipeline("feature-extraction", EMBED_MODEL, { ...options, dtype: "fp16" });
  // Run each model once so the first real sentence isn't slowed down by warm-up.
  await transcriber(new Float32Array(16000));
  await embedder(["warm up"], { pooling: "mean", normalize: true });
}

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case "load":
      return load();
    case "transcribe": {
      const started = performance.now();
      // The library allows 6 tokens per whole second, rounded down, so a 0.9 s "Hang up." gets none and comes back as "H".
      const seconds = Math.ceil(request.samples.length / 16000);
      const output = await transcriber(request.samples, { max_new_tokens: seconds * 9 + 2 });
      return { text: String(output.text ?? "").trim(), ms: Math.round(performance.now() - started) };
    }
    case "embed": {
      const output = await embedder(request.texts, { pooling: "mean", normalize: true });
      return output.tolist();
    }
  }
}

// Requests run one at a time, in order, so transcripts cannot arrive out of sequence.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      const value = await handle(request);
      self.postMessage({ id: request.id, type: "result", value } satisfies WorkerResponse);
    } catch (error) {
      self.postMessage({ id: request.id, type: "error", message: String(error) } satisfies WorkerResponse);
    }
  });
};
