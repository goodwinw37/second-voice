// Measures what speech recognition costs: the same 30 calls as eval/uk-calls.json,
// but spoken, degraded, and sent through the app's real segmenter, Moonshine and
// detector inside Chrome. scripts/eval.ts skips all of that and reads the text.
//
//   npm run dev                       (in another terminal)
//   node scripts/eval-audio.mjs       about 15 minutes for everything; first run downloads the models
//   node scripts/eval-audio.mjs --voices=Daniel,Rishi --conditions=clean,phone
//   node scripts/eval-audio.mjs --out=/some/folder     (default: a folder in your temp directory)
//
// Needs only the dev server and the macOS "say" command.
//
// Three kinds of run, so that a change in the numbers can be pinned on one cause:
//   Text only          each whole turn as perfect text. The reference.
//   Perfect words      the script's words, cut where the segmenter cut the audio. Shows
//                      what cutting and stitching cost, with every word right. It still
//                      gets words the segmenter threw away, so the next step's cost includes those.
//   Audio              the real pipeline. The gap from "perfect words" is what wrong or missing words cost.
// All three run in Chrome, because that is where the app runs.
//
// What this is NOT: real people on real phone lines. The voices are synthetic and
// the phone line is simulated. The caller reads the script perfectly, never talks
// over anyone and never mumbles, so treat these numbers as a best case for accents
// and audio quality, and not as an estimate of accuracy on real calls.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const SAMPLE_RATE = 16000;
const ALL_VOICES = ["Daniel", "Moira", "Rishi", "Karen", "Samantha", "Tessa"]; // en_GB, en_IE, en_IN, en_AU, en_US, en_ZA
const ALL_CONDITIONS = ["clean", "phone", "noisy"];
const SNR_DB = 15;
/** Silence around each turn. A real line is never just speech, and the segmenter learns its noise floor here. */
const PADDING_SECONDS = 0.5;

const option = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const VOICES = option("voices", ALL_VOICES.join(",")).split(",");
const CONDITIONS = option("conditions", ALL_CONDITIONS.join(",")).split(",");
const OUT = option("out", path.join(os.tmpdir(), "second-voice-eval-audio"));
const BASE_URL = process.env.EVAL_URL ?? "http://localhost:5173";

const calls = JSON.parse(fs.readFileSync(new URL("../eval/uk-calls.json", import.meta.url), "utf8"));

// ---- 1. Speech ------------------------------------------------------------------

/** "say" adds extra chunks to its WAV header, so walk them to find the audio. */
function readWav(file) {
  const bytes = fs.readFileSync(file);
  let at = 12;
  while (bytes.toString("ascii", at, at + 4) !== "data") {
    const size = bytes.readUInt32LE(at + 4);
    at += 8 + size + (size & 1);
  }
  const count = bytes.readUInt32LE(at + 4) / 2;
  return Float32Array.from({ length: count }, (_, i) => bytes.readInt16LE(at + 8 + i * 2) / 32768);
}

function saveWav(file, samples) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, i) => out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
}

/** Speaks one line, or reuses the file from an earlier run if the words haven't changed. */
function speak(voice, text) {
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 10);
  const file = path.join(OUT, "voices", voice, "say", `${hash}.wav`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    execFileSync("say", ["-v", voice, "--file-format=WAVE", "--data-format=LEI16@16000", "-o", file, text]);
  }
  return readWav(file);
}

// ---- 2. A simulated phone line --------------------------------------------------

/** A windowed-sinc low-pass filter: the standard recipe for a sharp filter in a few lines. */
function lowPass(cutoffHz, rate, taps = 255) {
  const middle = (taps - 1) / 2;
  const fc = cutoffHz / rate;
  return Float64Array.from({ length: taps }, (_, i) => {
    const x = i - middle;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    return sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
  });
}

/** Filters a signal, keeping it the same length and time-aligned. */
function convolve(signal, kernel) {
  const out = new Float32Array(signal.length);
  const middle = (kernel.length - 1) / 2;
  for (let n = 0; n < signal.length; n++) {
    let sum = 0;
    for (let k = 0; k < kernel.length; k++) {
      const at = n + middle - k;
      if (at >= 0 && at < signal.length) sum += kernel[k] * signal[at];
    }
    out[n] = sum;
  }
  return out;
}

const LOW = lowPass(300, SAMPLE_RATE);
const BAND_PASS = lowPass(3400, SAMPLE_RATE).map((value, i) => value - LOW[i]); // 300 to 3400 Hz
const RESTORE = lowPass(3800, SAMPLE_RATE);

/** Band-limits to 300-3400 Hz, drops to 8 kHz, and comes back to the 16 kHz the app expects. */
function phoneLine(samples) {
  const filtered = convolve(samples, BAND_PASS);
  const at8k = filtered.filter((_, i) => i % 2 === 0);
  const stuffed = new Float32Array(at8k.length * 2);
  at8k.forEach((value, i) => (stuffed[i * 2] = value * 2)); // Doubling makes up for the zeros in between.
  return convolve(stuffed, RESTORE);
}

/** Pink noise (more low rumble than hiss, unlike white noise). Seeded, so every run hears the same noise. */
function pinkNoise(length, seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0; // mulberry32
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let [b0, b1, b2] = [0, 0, 0];
  return Float32Array.from({ length }, () => {
    const white = random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046; // Paul Kellet's filter
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    return b0 + b1 + b2 + white * 0.1848;
  });
}

const rms = (samples) => Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);

/** Loudness while actually talking. Counting pauses would make the noise too quiet for the stated SNR. */
function activeSpeechLevel(samples) {
  const size = Math.round(SAMPLE_RATE * 0.03);
  const frames = [];
  for (let i = 0; i + size <= samples.length; i += size) frames.push(rms(samples.subarray(i, i + size)));
  const active = frames.filter((level) => level > Math.max(...frames) * 0.1);
  return Math.sqrt(active.reduce((sum, level) => sum + level * level, 0) / active.length);
}

/** The noise runs through the pauses too, and goes down the same line as the speech. */
function addNoise(samples, seed) {
  const noise = phoneLine(pinkNoise(samples.length, seed));
  const gain = activeSpeechLevel(samples) / 10 ** (SNR_DB / 20) / rms(noise);
  return samples.map((s, i) => s + noise[i] * gain);
}

/** One caller turn in every condition, ready to go down the pipeline. */
function turnAudio(voice, text, seed) {
  const spoken = speak(voice, text);
  const pad = Math.round(SAMPLE_RATE * PADDING_SECONDS);
  const clean = new Float32Array(spoken.length + pad * 2);
  clean.set(spoken, pad);
  const phone = phoneLine(clean);
  return { clean, phone, noisy: addNoise(phone, seed) };
}

// ---- 3. Word error rate ---------------------------------------------------------

const CONTRACTIONS = {
  "i'm": "i am", "i've": "i have", "i'll": "i will", "i'd": "i would", "you're": "you are", "you've": "you have",
  "you'll": "you will", "you'd": "you would", "we're": "we are", "we've": "we have", "we'll": "we will",
  "he's": "he is", "he'll": "he will", "she's": "she is", "it's": "it is", "it'll": "it will", "that's": "that is",
  "there's": "there is", "don't": "do not", "won't": "will not", "can't": "cannot", "shouldn't": "should not",
};
/** The script is in British spelling. An American spelling of the right word isn't a recognition error. */
const SPELLING = { neighbor: "neighbour", program: "programme", mom: "mum", okay: "ok", canceled: "cancelled" };
const NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** "sixteen hundred" and "1,600" should compare equal, so spoken numbers become digits. */
function numbersToDigits(words) {
  const out = [];
  let total = null;
  let current = 0;
  const finish = () => {
    if (total !== null) out.push(String(total + current));
    total = null;
    current = 0;
  };
  for (const word of words) {
    if (word in NUMBERS) {
      total ??= 0;
      current += NUMBERS[word];
    } else if (word === "hundred" && total !== null) {
      current *= 100;
    } else if (word === "thousand" && total !== null) {
      total += current * 1000;
      current = 0;
    } else {
      finish();
      out.push(word);
    }
  }
  finish();
  return out;
}

function normalise(text) {
  const plain = text
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/£\s*([\d,]+)/g, "$1 pounds")
    .replace(/(\d),(\d)/g, "$1$2")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/(\d):00\b/g, "$1")
    .replace(/[^a-z0-9' ]+/g, " ");
  const words = plain.split(/\s+/).filter(Boolean);
  const expanded = words.flatMap((word) => (CONTRACTIONS[word] ?? word.replace(/'/g, "")).split(" "));
  return numbersToDigits(expanded.map((word) => SPELLING[word] ?? word));
}

/**
 * Lines up two lists of words. `distance` is how many words must be swapped, added or
 * removed to turn one into the other. `position[k]` is how far through `script` the
 * first k words of `heard` reach, which tells us where a chunk boundary falls in the script.
 */
function align(script, heard) {
  // cost[i][j]: the edits needed to turn script[i...] into heard[j...].
  const cost = Array.from({ length: script.length + 1 }, () => new Array(heard.length + 1).fill(0));
  for (let i = script.length; i >= 0; i--) {
    for (let j = heard.length; j >= 0; j--) {
      if (i === script.length) cost[i][j] = heard.length - j;
      else if (j === heard.length) cost[i][j] = script.length - i;
      else cost[i][j] = Math.min(cost[i + 1][j] + 1, cost[i][j + 1] + 1, cost[i + 1][j + 1] + (script[i] === heard[j] ? 0 : 1));
    }
  }
  // Walk the cheapest route through the table.
  const position = [0];
  let [i, j] = [0, 0];
  while (j < heard.length) {
    if (i < script.length && cost[i][j] === cost[i + 1][j + 1] + (script[i] === heard[j] ? 0 : 1)) position[++j] = ++i;
    else if (cost[i][j] === cost[i][j + 1] + 1) position[++j] = i;
    else i++;
  }
  return { distance: cost[0][0], position };
}

// ---- 4. The real pipeline, inside Chrome ----------------------------------------

/** Runs in the page. Sets up the app's own modules and the three ways of running a call. */
async function setUpPipeline() {
  const { SpeechClient } = await import("/src/speech/client.ts");
  const { Segmenter } = await import("/src/audio/segmenter.ts");
  const { Detector, stitch, unfinishedTail } = await import("/src/detect/detector.ts");

  const speech = new SpeechClient();
  await speech.load();
  const detector = new Detector(speech.embed);
  await detector.prepare();

  // Copied from src/app/session.ts, which doesn't export it. Keep them in step.
  const cleanTranscript = (text) => {
    const cleaned = text.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, "").replace(/\bto-(night|day|morrow)\b/gi, "to$1").trim();
    return /^[\s.,!?-]*$/.test(cleaned) ? "" : cleaned;
  };

  const summary = () => {
    const { level, score, seen } = detector.current;
    return { level, score, seen };
  };

  /** The same steps as Session.onCallerText: stitch on the end of the last chunk, then listen. */
  const hearChunk = async (context, text) => {
    await detector.hear(stitch(context, text));
    return unfinishedTail(stitch(context, text));
  };

  window.evalAudio = {
    /** The reference: each whole turn handed over as perfect text, as scripts/eval.ts does. */
    async runText(turns) {
      detector.reset();
      for (const turn of turns) await detector.hear(turn);
      return summary();
    },

    /** Perfect words, but arriving in chunks and stitched the way a live call does it. */
    async runChunkedText(chunks) {
      detector.reset();
      let context = "";
      for (const chunk of chunks) context = await hearChunk(context, chunk);
      return summary();
    },

    /** The real thing: audio → segmenter → Moonshine → stitching → detector, one turn at a time. */
    async runAudio(encodedTurns) {
      detector.reset();
      let context = "";
      let waiting = [];
      const segmenter = new Segmenter({ sampleRate: 16000, pauseMs: 280, maxChunkMs: 6000 }, (chunk) => waiting.push(chunk));
      const turns = [];
      for (const encoded of encodedTurns) {
        const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
        segmenter.push(new Float32Array(bytes.buffer));
        segmenter.flush(); // The app does this when a caller finishes a turn.
        const chunks = [];
        for (const { samples } of waiting) {
          const seconds = samples.length / 16000;
          const { text: raw } = await speech.transcribe(samples);
          const text = cleanTranscript(raw);
          chunks.push({ seconds: +seconds.toFixed(2), text });
          if (text) context = await hearChunk(context, text);
        }
        waiting = [];
        turns.push({ chunks, levelAfter: detector.current.level });
      }
      return { ...summary(), turns };
    },
  };
}

const encode = (samples) => Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");

// ---- 5. Running it and reporting -------------------------------------------------

/** Cuts the script where the segmenter cut the audio, ending each piece as Moonshine ended that chunk. */
function cutLikeAudio(script, chunks) {
  const scriptWords = script.split(/\s+/);
  const bare = (text) => text.toLowerCase().replace(/[^a-z0-9' ]+/g, "").split(/\s+/).filter(Boolean);
  const heardByChunk = chunks.map((chunk) => bare(chunk.text));
  const { position } = align(scriptWords.map((word) => bare(word).join("")), heardByChunk.flat());
  let from = 0;
  let heardSoFar = 0;
  return chunks.map((chunk, i) => {
    heardSoFar += heardByChunk[i].length;
    const to = i === chunks.length - 1 ? scriptWords.length : position[heardSoFar];
    const piece = scriptWords.slice(from, to).join(" ").replace(/[,.;:!?]+$/, "");
    from = to;
    return piece + (chunk.text.match(/[.!?;]$/)?.[0] ?? "");
  }).filter(Boolean);
}

const tacticsOf = (result) => result.seen.map((s) => s.tactic);
const crossedLine = (a, b) => (a.level >= 2) !== (b.level >= 2) || (a.level >= 3) !== (b.level >= 3);

function tally(results, levelOf = (r) => r.level) {
  const count = (label, level) => results.filter((r) => r.call.label === label && levelOf(r) >= level).length;
  const total = (label) => results.filter((r) => r.call.label === label).length;
  const out = (label, level) => `${count(label, level)}/${total(label)}`;
  return [out(1, 2), out(1, 3), out(0, 2), out(0, 3)];
}

function tableRow(name, t, wer = "-", perfect = ["-", "-", "-", "-"]) {
  const cells = [...t, wer, ...perfect].map((cell) => cell.padStart(6));
  return `| ${name.padEnd(22)} | ${cells.join(" | ")} |`;
}

const werOf = (results) => {
  const turns = results.flatMap((r) => r.turns);
  const edits = turns.reduce((sum, t) => sum + t.editDistance, 0);
  const words = turns.reduce((sum, t) => sum + t.referenceWords, 0);
  return `${((100 * edits) / words).toFixed(1)}%`;
};

const browser = await chromium.launchPersistentContext(path.join(OUT, "chrome-profile"), { channel: "chrome", headless: true });
const page = browser.pages()[0] ?? (await browser.newPage());
// A small file from the dev server, not the app's front page, which would load a second copy of the models.
await page.goto(`${BASE_URL}/tap-worklet.js`);
console.error("Loading models...");
await page.evaluate(setUpPipeline);

const reference = [];
for (const call of calls) reference.push(await page.evaluate((turns) => window.evalAudio.runText(turns), call.caller));

const rows = [tableRow("Text only, in Chrome", tally(reference.map((r, i) => ({ ...r, call: calls[i] }))))];
const runs = [];

for (const voice of VOICES) {
  // Speak everything once, then build each condition from it.
  const audio = calls.map((call, c) => call.caller.map((text, t) => turnAudio(voice, text, 1000 * c + t + 1)));

  for (const condition of CONDITIONS) {
    const results = [];
    for (const [c, call] of calls.entries()) {
      // Save, then read back, so the audio being tested is exactly the file you can listen to.
      const encoded = audio[c].map((turn, t) => {
        const file = path.join(OUT, "voices", voice, condition, `${call.id}-${t}.wav`);
        saveWav(file, turn[condition]);
        return encode(readWav(file));
      });
      const result = await page.evaluate((turns) => window.evalAudio.runAudio(turns), encoded);

      result.turns.forEach((turn, t) => {
        const expected = normalise(call.caller[t]);
        turn.editDistance = align(expected, normalise(turn.chunks.map((chunk) => chunk.text).join(" "))).distance;
        turn.referenceWords = expected.length;
      });

      const cut = result.turns.flatMap((turn, t) => cutLikeAudio(call.caller[t], turn.chunks));
      const perfectWords = await page.evaluate((chunks) => window.evalAudio.runChunkedText(chunks), cut);
      results.push({ ...result, voice, condition, call, perfectWords, reference: reference[c] });
    }
    runs.push(...results);
    rows.push(tableRow(`${voice} ${condition}`, tally(results), werOf(results), tally(results, (r) => r.perfectWords.level)));
    console.error(rows.at(-1));
  }
}
await browser.close();

for (const condition of CONDITIONS) {
  const results = runs.filter((r) => r.condition === condition);
  rows.push(tableRow(`All voices, ${condition}`, tally(results), werOf(results), tally(results, (r) => r.perfectWords.level)));
}

// A decision changed if the call ended on the other side of "coach speaks" or "hang up".
// If perfect words with the same cuts end up in the same place, the words weren't to blame.
const changes = runs
  .filter((r) => crossedLine(r, r.reference))
  .map((r) => ({
    voice: r.voice,
    condition: r.condition,
    call: r.call.id,
    label: r.call.label ? "scam" : "genuine",
    text: r.reference.level,
    perfectWords: r.perfectWords.level,
    audio: r.level,
    cause: crossedLine(r, r.perfectWords) ? "wrong or missing words" : "cutting and stitching",
    addedByCuts: r.perfectWords.seen.filter((s) => !tacticsOf(r.reference).includes(s.tactic)),
    lost: r.perfectWords.seen.filter((s) => !tacticsOf(r).includes(s.tactic)),
    gained: r.seen.filter((s) => !tacticsOf(r.perfectWords).includes(s.tactic)),
  }));

// Everything heard goes to a file, because that's where you look when a number surprises you.
const resultsFile = path.join(OUT, "results.json");
fs.writeFileSync(resultsFile, JSON.stringify({ reference, runs, changes }, null, 1));

console.log("\nSynthetic voices and a simulated phone line: NOT real people or real phone lines.\n");
console.log(tableRow("Run", ["Scam2", "Scam3", "Real2", "Real3"], "WER", ["Scam2", "Scam3", "Real2", "Real3"]));
console.log("(2 = the coach spoke, 3 = it said hang up. The second block is perfect words with the audio's cuts.)");
for (const row of rows) console.log(row);

console.log(`\nCalls where a decision changed (${changes.length}). Levels are text, then perfect words, then audio:`);
const describe = (signals) => signals.map((s) => `${s.tactic} from "${s.evidence.slice(0, 70)}"`).join(", ") || "-";
for (const c of changes) {
  console.log(`  ${c.voice} ${c.condition}, ${c.call} (${c.label}): ${c.text} > ${c.perfectWords} > ${c.audio}, ${c.cause}. Added by the cuts: ${describe(c.addedByCuts)}. Lost to bad words: ${describe(c.lost)}. Gained from bad words: ${describe(c.gained)}`);
}
console.log(`\nAudio is in ${path.join(OUT, "voices")}`);
console.log(`Every transcript is in ${resultsFile}`);
