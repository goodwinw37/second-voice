// Cuts a stream of audio into chunks of speech worth transcribing.
//
// A simple energy-based voice detector: it tracks the room's noise floor and
// treats anything clearly above it as speech. A chunk ends at a pause, or at a
// maximum length so that a long sentence still gets acted on while it is being
// said. A forced cut lands on the quietest recent moment, because cutting through
// a word makes speech models invent words (we saw "rent is due today" come out as
// "rent is due to death"). Pure logic with no browser APIs, so it can be unit tested.

export interface SegmenterOptions {
  sampleRate: number;
  /** Silence needed to end a chunk. */
  pauseMs: number;
  /** Longest chunk before it is cut anyway. */
  maxChunkMs: number;
  /** Chunks shorter than this are treated as noise. */
  minSpeechMs: number;
  /** How far above the noise floor counts as speech. */
  speechRatio: number;
  /** Below this level is always silence, whatever the noise floor is doing. */
  absoluteFloor: number;
}

export const DEFAULT_SEGMENTER: Omit<SegmenterOptions, "sampleRate"> = {
  pauseMs: 450,
  maxChunkMs: 4000,
  minSpeechMs: 250,
  speechRatio: 3,
  absoluteFloor: 0.008,
};

export interface Chunk {
  samples: Float32Array;
  /** How long ago the last speech in this chunk ended. Used to measure latency honestly. */
  trailingSilenceMs: number;
}

const FRAME_MS = 30;
/** Audio kept from just before speech starts, so first syllables are not clipped. */
const PREROLL_FRAMES = 6;
/** A forced cut looks for the quietest frame in the last part of the chunk. */
const CUT_SEARCH_FROM = 0.6;
/** Two seconds of frames, for tracking the noise floor. */
const NOISE_WINDOW_FRAMES = Math.round(2000 / FRAME_MS);

const rms = (frame: Float32Array) => Math.sqrt(frame.reduce((sum, s) => sum + s * s, 0) / frame.length);

export class Segmenter {
  private options: SegmenterOptions;
  private frameSize: number;
  private partial: number[] = [];
  private frames: Float32Array[] = [];
  private preroll: Float32Array[] = [];
  private noiseFloor = 0.005;
  private recentEnergy: number[] = [];
  private speechFrames = 0;
  private silentFrames = 0;
  private clockMs = 0;
  private lastSpeechMs = 0;
  private onChunk: (chunk: Chunk) => void;

  constructor(options: Partial<SegmenterOptions> & { sampleRate: number }, onChunk: (chunk: Chunk) => void) {
    this.options = { ...DEFAULT_SEGMENTER, ...options };
    this.frameSize = Math.round((this.options.sampleRate * FRAME_MS) / 1000);
    this.onChunk = onChunk;
  }

  /** Whether speech is being collected right now. */
  get inSpeech(): boolean {
    return this.frames.length > 0;
  }

  push(samples: Float32Array): void {
    for (const sample of samples) {
      this.partial.push(sample);
      if (this.partial.length === this.frameSize) {
        this.processFrame(Float32Array.from(this.partial));
        this.partial.length = 0;
      }
    }
  }

  /** Sends whatever speech has been collected so far. */
  flush(): void {
    this.emit(this.clockMs - this.lastSpeechMs);
    this.frames = [];
    this.speechFrames = 0;
    this.silentFrames = 0;
  }

  private emit(trailingSilenceMs: number): void {
    if (this.speechFrames * FRAME_MS < this.options.minSpeechMs) return;
    const length = this.frames.reduce((n, f) => n + f.length, 0);
    const samples = new Float32Array(length);
    let offset = 0;
    for (const frame of this.frames) {
      samples.set(frame, offset);
      offset += frame.length;
    }
    this.onChunk({ samples, trailingSilenceMs });
  }

  /** Sends the chunk up to its quietest recent frame, and keeps the rest for the next chunk. */
  private cutAtQuietestFrame(): void {
    let cut = this.frames.length - 1;
    let quietest = Infinity;
    for (let i = Math.floor(this.frames.length * CUT_SEARCH_FROM); i < this.frames.length; i++) {
      const energy = rms(this.frames[i]);
      if (energy < quietest) {
        quietest = energy;
        cut = i;
      }
    }
    const rest = this.frames.slice(cut + 1);
    this.frames = this.frames.slice(0, cut + 1);
    this.emit(rest.length * FRAME_MS);
    this.frames = rest;
    this.speechFrames = rest.length;
    this.silentFrames = 0;
  }

  private processFrame(frame: Float32Array): void {
    this.clockMs += FRAME_MS;
    const energy = rms(frame);
    const threshold = Math.max(this.noiseFloor * this.options.speechRatio, this.options.absoluteFloor);
    const isSpeech = energy > threshold;

    // The noise floor is the quietest frame in the last two seconds, whether or not it was judged
    // to be speech. Even fast talkers pause within two seconds, so this finds the noise under the
    // voice. Learning only from frames already judged quiet fails on a noisy line: if the noise
    // starts out above the threshold, every frame counts as speech and the floor never moves.
    this.recentEnergy.push(energy);
    if (this.recentEnergy.length > NOISE_WINDOW_FRAMES) this.recentEnergy.shift();
    this.noiseFloor = Math.min(...this.recentEnergy);

    if (isSpeech) {
      if (this.frames.length === 0) this.frames.push(...this.preroll);
      this.frames.push(frame);
      this.speechFrames++;
      this.silentFrames = 0;
      this.lastSpeechMs = this.clockMs;
    } else if (this.frames.length > 0) {
      this.frames.push(frame);
      this.silentFrames++;
    }

    this.preroll.push(frame);
    if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();

    if (this.frames.length === 0) return;
    if (this.silentFrames * FRAME_MS >= this.options.pauseMs) this.flush();
    else if (this.frames.length * FRAME_MS >= this.options.maxChunkMs) this.cutAtQuietestFrame();
  }
}
