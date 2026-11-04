// A promise-based wrapper around the speech worker.

import type { WorkerRequest, WorkerResponse } from "./worker.ts";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

const REQUEST_TIMEOUT_MS = 10000;

export interface LoadProgress {
  loaded: number;
  total: number;
}

export class SpeechClient {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private files = new Map<string, LoadProgress>();
  onProgress: (progress: LoadProgress) => void = () => {};

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        this.files.set(message.file, { loaded: message.loaded, total: message.total });
        const all = [...this.files.values()];
        this.onProgress({
          loaded: all.reduce((sum, f) => sum + f.loaded, 0),
          total: all.reduce((sum, f) => sum + f.total, 0),
        });
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.type === "error") entry.reject(new Error(message.message));
      else entry.resolve(message.value);
    };
    this.worker.onerror = (event) => {
      for (const entry of this.pending.values()) entry.reject(new Error(event.message));
      this.pending.clear();
    };
  }

  private send<T>(request: WithoutId<WorkerRequest>, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // A worker that has died never replies, and that mustn't look like silence.
      if (request.type !== "load") setTimeout(() => { if (this.pending.delete(id)) reject(new Error("The speech model stopped responding")); }, REQUEST_TIMEOUT_MS);
      this.worker.postMessage({ ...request, id }, transfer);
    });
  }

  load(): Promise<void> {
    return this.send({ type: "load" });
  }

  transcribe(samples: Float32Array): Promise<{ text: string; ms: number }> {
    return this.send({ type: "transcribe", samples }, [samples.buffer as ArrayBuffer]);
  }

  embed = (texts: string[]): Promise<number[][]> => {
    return this.send({ type: "embed", texts });
  };
}
