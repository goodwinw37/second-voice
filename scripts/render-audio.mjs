// Records every coach line and every scripted call line with a local voice model.
//
// You only need this if you change the words. The results live in public/audio,
// so running the app needs no voice model and the coach can speak instantly.
//
// The voice model is deliberately not a normal dependency, because it is large and
// only needed here. Install it first:
//
//   npm install --no-save kokoro-js
//   npm run render-audio            renders anything missing or changed
//   npm run render-audio -- --force renders everything

import fs from "node:fs";
import crypto from "node:crypto";
import { KokoroTTS } from "kokoro-js";
import { LINES } from "../src/coach/lines.ts";
import { SCENARIOS, clipId } from "../src/call/scenarios.ts";

const OUT = "public/audio";
const MANIFEST = `${OUT}/manifest.json`;
const VOICES = { coach: "bf_emma", you: "bf_isabella", male: "bm_george", female: "bf_lily", child: "bf_alice" };
const SCENARIO_VOICE = { bank: VOICES.male, family: VOICES.child, genuine: VOICES.female };

fs.mkdirSync(OUT, { recursive: true });
const previous = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : {};
const force = process.argv.includes("--force");

const jobs = [];
for (const [id, line] of Object.entries(LINES)) jobs.push({ id: `coach-${id}`, text: line.text, voice: VOICES.coach });
for (const scenario of SCENARIOS) {
  for (const step of scenario.steps) {
    jobs.push({ id: clipId(scenario.id, step.id, "caller"), text: step.text, voice: SCENARIO_VOICE[scenario.id] });
    (step.demoReplies ?? []).forEach((text, i) => {
      jobs.push({ id: clipId(scenario.id, step.id, `you${i}`), text, voice: VOICES.you });
    });
  }
}

/** Writes 16-bit PCM, which is half the size of the voice model's own 32-bit output. */
function saveWav(path, samples, sampleRate) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, i) => out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2));
  fs.writeFileSync(path, out);
}

// The voice reads figures as an amount, so "159" came out as "one hundred and fifty nine".
const spoken = (text) => text.replace(/\b159\b/g, "one five nine").replace(/\b999\b/g, "nine nine nine");
const hash = (job) => crypto.createHash("sha1").update(`${job.voice}|${spoken(job.text)}`).digest("hex").slice(0, 12);
const todo = jobs.filter((job) => force || previous[job.id]?.hash !== hash(job) || !fs.existsSync(`${OUT}/${job.id}.wav`));
console.log(`${jobs.length} clips, ${todo.length} to render`);

const manifest = {};
for (const job of jobs) if (previous[job.id]) manifest[job.id] = previous[job.id];

if (todo.length > 0) {
  const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
  for (const job of todo) {
    const audio = await tts.generate(spoken(job.text), { voice: job.voice });
    saveWav(`${OUT}/${job.id}.wav`, audio.audio, audio.sampling_rate);
    manifest[job.id] = { hash: hash(job), seconds: +(audio.audio.length / audio.sampling_rate).toFixed(2) };
    console.log(`  ${job.id}: ${manifest[job.id].seconds}s`);
  }
}

// Remove clips for lines that no longer exist.
const keep = new Set(jobs.map((job) => `${job.id}.wav`));
for (const file of fs.readdirSync(OUT)) if (file.endsWith(".wav") && !keep.has(file)) fs.rmSync(`${OUT}/${file}`);
const ordered = Object.fromEntries(Object.entries(manifest).filter(([id]) => jobs.some((j) => j.id === id)).sort());
fs.writeFileSync(MANIFEST, `${JSON.stringify(ordered, null, 2)}\n`);
const total = Object.values(ordered).reduce((sum, clip) => sum + clip.seconds, 0);
console.log(`Done. ${Object.keys(ordered).length} clips, ${total.toFixed(0)} seconds of audio.`);
