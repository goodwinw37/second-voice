// Measures the detector on labelled calls, one caller turn at a time, just as it
// would hear them live.
//
// Every call also plays through the real Coach, with both people's turns. "Heard a hang-up
// line" is the figure that matters: it counts lines like "Stop, don't read that out", which the
// caller's level alone can't show.
//
//   npm run eval                      tuning data: public train, multi-agent train, UK calls, YouTube dev half
//   npm run eval -- --test            the public test split
//   npm run eval -- --independent     test data no rule was written from (see README)
//   npm run eval -- --youtube-holdout the half of the YouTube calls kept unread
//   npm run eval -- --sweep           try several semantic settings on the training data
//   npm run eval -- --everyday        known awkward sentences, one at a time
//   npm run eval -- --show-misses     print calls the detector got wrong

import fs from "node:fs";
import { pipeline, env } from "@huggingface/transformers";
import { Coach, classifyUser } from "../src/coach/coach.ts";
import type { LineId } from "../src/coach/lines.ts";
import { Detector, DEFAULT_SEMANTIC, type Embedder, type SemanticConfig } from "../src/detect/detector.ts";

interface Turn {
  who: "caller" | "person";
  text: string;
}

interface LabelledCall {
  id: string;
  label: 0 | 1;
  type: string;
  turns: Turn[];
}

/** Coach lines that tell someone to hang up. */
const HANG_UP_LINES: ReadonlySet<LineId> = new Set(["credentials", "safe_account", "untraceable_payment", "remote_access", "coached_lie", "get_out", "disclosure_stop"]);

const args = new Set(process.argv.slice(2));

/** Turns a dialogue tagged "caller:" / "receiver:" in any capitalisation into turns. */
function parseTurns(dialogue: string): Turn[] {
  return dialogue
    .split(/(?=\b(?:caller|receiver|suspect|innocent|scammer|victim):)/i)
    .map((turn) => turn.trim())
    .flatMap((turn): Turn[] => {
      const tag = turn.match(/^(caller|receiver|suspect|innocent|scammer|victim):\s*/i);
      if (!tag) return [];
      return [{ who: /^(caller|suspect|scammer)$/i.test(tag[1]) ? "caller" : "person", text: turn.slice(tag[0].length).trim() }];
    });
}

function loadPublic(split: "train" | "test"): LabelledCall[] {
  const rows = JSON.parse(fs.readFileSync(`eval/data/scam-dialogue-${split}.json`, "utf8"));
  return rows.map((row: { dialogue: string; type: string; label: 0 | 1 }, i: number) => ({
    id: `${split}-${i}`,
    label: row.label,
    type: row.type,
    turns: parseTurns(row.dialogue),
  }));
}

function loadIndependent(file: string, prefix: string): LabelledCall[] {
  const rows = JSON.parse(fs.readFileSync(`eval/data/${file}`, "utf8"));
  return rows.map((row: { dialogue: string; type: string; labels: 0 | 1 }, i: number) => ({
    id: `${prefix}-${i}`,
    label: row.labels,
    type: row.type,
    turns: parseTurns(row.dialogue),
  }));
}

function splitByType(calls: LabelledCall[], half: "dev" | "holdout"): LabelledCall[] {
  const seenOfType = new Map<string, number>();
  return calls.filter((call) => {
    const position = seenOfType.get(call.type) ?? 0;
    seenOfType.set(call.type, position + 1);
    return (position % 2 === 0) === (half === "dev");
  });
}

function loadUk(): LabelledCall[] {
  const rows: Array<{ id: string; label: 0 | 1; type: string; caller: string[] }> = JSON.parse(fs.readFileSync("eval/uk-calls.json", "utf8"));
  return rows.map(({ caller, ...row }) => ({ ...row, turns: caller.map((text) => ({ who: "caller" as const, text })) }));
}

/** A live call hears someone in chunks, so a long reply shouldn't count as one read-out or one command. */
function chunksOfSpeech(text: string, words = 12): string[] {
  const all = text.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < all.length; i += words) out.push(all.slice(i, i + words).join(" "));
  return out;
}

interface Outcome {
  call: LabelledCall;
  maxLevel: number;
  /** How far through the caller's turns the coach first spoke, from 0 to 1. */
  warnedAt: number | null;
  tactics: string[];
  lines: LineId[];
}

async function runCall(call: LabelledCall, detector: Detector): Promise<Outcome> {
  detector.reset();
  const coach = new Coach();
  const lines: LineId[] = [];
  const callerTurns = call.turns.filter((t) => t.who === "caller").length;
  let heard = 0;
  let warnedAt: number | null = null;
  let now = 0;
  for (const turn of call.turns) {
    now += 6000;
    if (turn.who === "caller") {
      const fresh = await detector.hear(turn.text);
      heard++;
      if (warnedAt === null && detector.current.level >= 2) warnedAt = heard / callerTurns;
      const utterance = coach.afterCaller(fresh, detector.current, now);
      if (utterance) lines.push(utterance.line);
    } else {
      for (const chunk of chunksOfSpeech(turn.text)) {
        const utterance = coach.afterUser(classifyUser(chunk), detector.current, now);
        if (utterance) lines.push(utterance.line);
      }
    }
  }
  return { call, maxLevel: detector.current.level, warnedAt, tactics: detector.current.seen.map((s) => `${s.tactic}(${s.via})`), lines };
}

function report(name: string, outcomes: Outcome[]): void {
  const scams = outcomes.filter((o) => o.call.label === 1);
  const genuine = outcomes.filter((o) => o.call.label === 0);
  const count = (list: Outcome[], level: number) => list.filter((o) => o.maxLevel >= level).length;
  const heardHangUp = (list: Outcome[]) => list.filter((o) => o.lines.some((line) => HANG_UP_LINES.has(line))).length;
  const heardStop = (list: Outcome[]) => list.filter((o) => o.lines.includes("disclosure_stop")).length;
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
  const warnTimes = scams.map((o) => o.warnedAt).filter((t): t is number => t !== null).sort((a, b) => a - b);
  const median = warnTimes.length ? warnTimes[Math.floor(warnTimes.length / 2)] : null;

  console.log(`\n${name}  (${scams.length} scam, ${genuine.length} genuine)`);
  console.log(`  Scam calls where the coach spoke:         ${count(scams, 2)}/${scams.length} (${pct(count(scams, 2), scams.length)})`);
  console.log(`  Scam calls where it said hang up:         ${count(scams, 3)}/${scams.length} (${pct(count(scams, 3), scams.length)})`);
  console.log(`  Genuine calls where the coach spoke:      ${count(genuine, 2)}/${genuine.length} (${pct(count(genuine, 2), genuine.length)})`);
  console.log(`  Genuine calls where it said hang up:      ${count(genuine, 3)}/${genuine.length} (${pct(count(genuine, 3), genuine.length)})`);
  console.log(`  Scam calls that heard a hang-up line:     ${heardHangUp(scams)}/${scams.length} (${pct(heardHangUp(scams), scams.length)}), of which "stop reading that out" ${heardStop(scams)}`);
  console.log(`  Genuine calls that heard a hang-up line:  ${heardHangUp(genuine)}/${genuine.length} (${pct(heardHangUp(genuine), genuine.length)}), of which "stop reading that out" ${heardStop(genuine)}`);
  if (median !== null) console.log(`  Median point in a scam call it first spoke: ${(median * 100).toFixed(0)}% of the way through`);

  const types = [...new Set(outcomes.map((o) => `${o.call.label}|${o.call.type}`))].sort();
  for (const key of types) {
    const [label, type] = key.split("|");
    const group = outcomes.filter((o) => o.call.type === type && String(o.call.label) === label);
    console.log(`    ${label === "1" ? "scam   " : "genuine"} ${type.padEnd(26)} spoke ${count(group, 2)}/${group.length}, hang up ${count(group, 3)}/${group.length}`);
  }

  if (args.has("--show-misses")) {
    const misses = [...scams.filter((o) => o.maxLevel < 2), ...genuine.filter((o) => o.maxLevel >= 2)];
    const shownPerType = new Map<string, number>();
    const perType = 5;
    for (const miss of misses) {
      const key = `${miss.call.label}|${miss.call.type}`;
      shownPerType.set(key, (shownPerType.get(key) ?? 0) + 1);
      if (shownPerType.get(key)! > perType) continue;
      console.log(`\n  [${miss.call.label ? "MISSED SCAM" : "FALSE ALARM"} level ${miss.maxLevel}] ${miss.call.id} ${miss.call.type}: ${miss.tactics.join(", ") || "(nothing)"}`);
      console.log(`    ${miss.call.turns.filter((t) => t.who === "caller").map((t) => t.text).join(" | ").slice(0, 900)}`);
    }
  }
}

async function makeEmbedder(): Promise<Embedder> {
  env.allowLocalModels = false;
  const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "fp16" }); // The same model the app runs.
  const cache = new Map<string, number[]>();
  return async (texts) => {
    const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
    for (let i = 0; i < missing.length; i += 32) {
      const batch = missing.slice(i, i + 32);
      const output = await extractor(batch, { pooling: "mean", normalize: true });
      const vectors = output.tolist() as number[][];
      batch.forEach((text, j) => cache.set(text, vectors[j]));
    }
    return texts.map((t) => cache.get(t)!);
  };
}

async function runAll(calls: LabelledCall[], embed: Embedder | null, config: SemanticConfig = DEFAULT_SEMANTIC): Promise<Outcome[]> {
  const detector = new Detector(embed, config);
  await detector.prepare();
  const out: Outcome[] = [];
  for (const call of calls) out.push(await runCall(call, detector));
  return out;
}

/** The same calls with and without the semantic matcher, to show what each layer adds. */
async function reportBoth(name: string, calls: LabelledCall[]): Promise<void> {
  const empty = calls.filter((c) => !c.turns.some((t) => t.who === "caller")).length;
  if (empty) console.log(`WARNING: ${empty}/${calls.length} ${name} calls have no parsed caller turns`);
  report(`${name}: patterns only`, await runAll(calls, null));
  report(`${name}: patterns + semantic`, await runAll(calls, embed));
}

const embed = await makeEmbedder();
const youtube = () => loadIndependent("youtube-scam-conversations.json", "yt");

if (args.has("--sweep")) {
  const train = [...loadPublic("train"), ...loadIndependent("multi-agent-scam-train.json", "ma")];
  const uk = loadUk();
  console.log("threshold margin | train: scam spoke, genuine spoke, genuine hang-up | UK: scam spoke, genuine spoke, genuine hang-up");
  for (const threshold of [0.42, 0.45, 0.48, 0.5, 0.52, 0.55]) {
    for (const margin of [0.08, 0.1, 0.12, 0.15, 0.2]) {
      const config = { threshold, margin };
      const a = await runAll(train, embed, config);
      const b = await runAll(uk, embed, config);
      const rate = (list: Outcome[], label: number, level: number) => {
        const group = list.filter((o) => o.call.label === label);
        return `${((100 * group.filter((o) => o.maxLevel >= level).length) / group.length).toFixed(1)}%`;
      };
      console.log(`${threshold.toFixed(2)} ${margin.toFixed(2)} | ${rate(a, 1, 2)} ${rate(a, 0, 2)} ${rate(a, 0, 3)} | ${rate(b, 1, 2)} ${rate(b, 0, 2)} ${rate(b, 0, 3)}`);
    }
  }
} else if (args.has("--everyday")) {
  const { ordinary, scams } = JSON.parse(fs.readFileSync("eval/everyday.json", "utf8")) as { ordinary: string[]; scams: string[] };
  const levelOf = async (text: string) => {
    const detector = new Detector(embed);
    await detector.prepare();
    await detector.hear(text);
    return detector.current;
  };
  let wrong = 0;
  for (const text of ordinary) {
    const state = await levelOf(text);
    if (state.level >= 3) {
      wrong++;
      console.log(`  told to hang up: "${text}" ${state.seen.map((s) => `${s.tactic}(${s.via} ${s.similarity?.toFixed(2) ?? ""})`).join(", ")}`);
    }
  }
  console.log(`Ordinary sentences told to hang up: ${wrong}/${ordinary.length}`);
  wrong = 0;
  for (const text of scams) {
    if ((await levelOf(text)).level < 3) {
      wrong++;
      console.log(`  not told to hang up: "${text}"`);
    }
  }
  console.log(`Scam sentences not told to hang up: ${wrong}/${scams.length}`);
} else if (args.has("--youtube-holdout")) {
  await reportBoth("YouTube holdout half", splitByType(youtube(), "holdout"));
} else if (args.has("--independent")) {
  await reportBoth("Multi-agent generated test calls", loadIndependent("multi-agent-scam-test.json", "ma"));
} else if (args.has("--test")) {
  await reportBoth("Public test split", loadPublic("test"));
} else {
  await reportBoth("Public train split", loadPublic("train"));
  await reportBoth("Multi-agent train split", loadIndependent("multi-agent-scam-train.json", "ma"));
  await reportBoth("Hand-written UK calls", loadUk());
  await reportBoth("YouTube dev half", splitByType(youtube(), "dev"));
}
