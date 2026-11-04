// Turns what the caller said into a risk level for the whole call.
//
// Pure logic with no audio or browser APIs, so the same code runs in the app,
// the unit tests and the evaluation script.

import { PROTECTIVE_WORDING, SAFE_EXEMPLARS, TACTICS, type Tactic, type TacticId } from "./tactics.ts";

/** 0 = quiet, 1 = watching (screen only), 2 = warn (coach speaks), 3 = get out (hang up). */
export type RiskLevel = 0 | 1 | 2 | 3;

export const WARN_SCORE = 3;
export const GET_OUT_SCORE = 6;

/**
 * Similarity blurs meaning: on a genuine insurance call, "You gave us permission to contact you about
 * potential savings" scored 0.56 against the safe-account examples. So when only the semantic matcher saw a
 * decisive tactic, it warns but can't say "hang up", unless the sentence is very close to the examples.
 * If the caller goes on to ask outright, that counts in full.
 */
const LOOKALIKE_WEIGHT = 3;
const STRONG_SIMILARITY = 0.65;

/** Turns a batch of sentences into unit-length vectors. Supplied by the caller of this module. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface SemanticConfig {
  /** Minimum average similarity to a tactic's closest examples. */
  threshold: number;
  /** How much closer the sentence must be to the tactic than to genuine-caller speech. */
  margin: number;
}

export const DEFAULT_SEMANTIC: SemanticConfig = { threshold: 0.5, margin: 0.15 };

export interface Signal {
  tactic: TacticId;
  evidence: string;
  via: "pattern" | "semantic";
  similarity?: number;
}

export interface CallState {
  score: number;
  level: RiskLevel;
  seen: Signal[];
}

interface ExemplarIndex {
  byTactic: Map<TacticId, number[][]>;
  safe: number[][];
}

const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);

/** Average similarity to the k closest examples: steadier than the single closest. */
function topKMean(vector: number[], examples: number[][], k = 2): number {
  const sims = examples.map((e) => dot(vector, e)).sort((a, b) => b - a);
  const top = sims.slice(0, k);
  return top.reduce((sum, value) => sum + value, 0) / top.length;
}

/**
 * Speech models can spell out "PIN" as "P. I. N." or "P I N". Left alone, those full stops
 * would split the sentence, and the letters wouldn't match. Only known words are joined when
 * they come with spaces, so "the c a t" stays as it is.
 */
export function joinSpelledLetters(text: string): string {
  return text
    .replace(/\b(?:[A-Za-z]\.\s*){2,}(?:[A-Za-z]\b)?/g, (match) => `${match.replace(/[.\s]/g, "").toUpperCase()} `)
    .replace(/\b([a-z])[\s-]+([a-z])[\s-]+([a-z])\b/gi, (match, a, b, c) =>
      /^(pin|otp|cvv|cvc)$/i.test(a + b + c) ? (a + b + c).toUpperCase() : match,
    )
    .replace(/\bpass word\b/gi, "password");
}

/** Words that open a new demand, as in "..., read me the code". */
const DEMAND = String.raw`transfer|move|send|read|give|tell|buy|pay|install|download|don'?t|dont|do not|what'?s|what is|enter|type|confirm|i need|we need`;

/** Where one clause ends and the next begins. Protective wording only excuses its own clause, so this decides what it can hide. */
const CLAUSE_BREAK = new RegExp(
  [
    // The end of a sentence.
    String.raw`(?<=[.!?;])\s+`,
    // ", but" and ", just", unless that comma is inside "if anyone asks, just say".
    String.raw`(?<!\b(?:asks?|asked|calls?|questions?|why|know)),\s+(?=but\b|just\b|only\b)`,
    String.raw`\s+but\s+`,
    // A comma or "and" before a new demand, unless it's still inside "ask you to", or is a list joined by "or".
    String.raw`(?<!\b(?:ask|asks|asking|asked|tell|telling|told|require|requires)\s+you\s+to\b[^.?!;]*)(?:\s+and|,)\s+(?=(?:(?:then|just|please|now|so)\s+)*(?:${DEMAND})\b)(?![^.?!;]*\bor\s+(?:to\s+)?(?:read|give|share|transfer|move|send|tell|pay|buy|install|download|disclose|provide|your|any)\b)`,
    // Phrases that start a demand with no punctuation before them.
    String.raw`\s+(?=so please\b|now i need\b|if you (?:just )?(?:give|read|tell|send|confirm|enter)\b)`,
  ].join("|"),
  "i",
);

export function splitClauses(text: string): string[] {
  return joinSpelledLetters(text)
    .split(CLAUSE_BREAK)
    .map((s) => s?.trim())
    .filter((s) => s?.length > 0);
}

/** A new chunk starting like this is a fresh request, not the end of the sentence before it. */
const NEW_ASK = /^\W*((so|now|ok(ay)?|right|just|first|next)\W+)*(please\W+)?((can|could|would|will)\s+you\W+)?(please\W+|just\W+)?(read|give|tell|send|enter|type|confirm|i need|we need|i want|what'?s|what is|transfer|move|buy|install|download|pay|withdraw|you (need|have|must))\b/i;
/** A chunk starting like this is carrying on the last one, even if the speech model put a full stop before it. */
const CONTINUES = /^\W*(to|or|nor|not|ever)\b/i;
/** A chunk ending like this is mid-sentence: "We will never ask you to" + "read out a code". */
const MID_SENTENCE = /\b(to|never|not|n't|don'?t|won'?t|will|would|must|should|and|or)\W*$/i;

/** Joins a chunk of speech onto the unfinished end of the last one. */
export function stitch(tail: string, text: string): string {
  if (!tail) return text;
  const bare = tail.replace(/[.!?;"')\]]+\s*$/, "");
  if (MID_SENTENCE.test(bare) || CONTINUES.test(text)) return `${bare} ${text}`;
  return NEW_ASK.test(text) || bare !== tail ? `${bare}. ${text}` : `${bare} ${text}`;
}

/**
 * The end of a chunk that may carry on in the next one. A sentence that really finished has been judged,
 * but the speech model puts a full stop at any pause, so protective or mid-sentence wording is kept either way.
 */
export function unfinishedTail(text: string, maxWords = 12): string {
  const lastSentence = text.split(/(?<=[.!?;])\s+/).at(-1) ?? "";
  const bare = lastSentence.replace(/[.!?;"')\]]+\s*$/, "");
  if (bare !== lastSentence && !MID_SENTENCE.test(bare) && !PROTECTIVE_WORDING.test(bare)) return "";
  return lastSentence.split(/\s+/).slice(-maxWords).join(" ");
}

export function matchPatterns(clause: string): Tactic[] {
  const isProtective = PROTECTIVE_WORDING.test(clause);
  return TACTICS.filter(
    (t) => !(t.guarded && isProtective) && !t.except?.test(clause) && t.patterns.some((p) => p.test(clause)),
  );
}

/** True if this signal alone can say "hang up": a decisive tactic, heard as an explicit ask. */
export function isDecisive(signal: Signal): boolean {
  const tactic = TACTICS.find((t) => t.id === signal.tactic)!;
  if (!tactic.decisive) return false;
  return signal.via === "pattern" || (signal.similarity ?? 0) >= STRONG_SIMILARITY;
}

/** What to call this signal on screen. A lookalike hasn't been heard as an explicit ask, so it doesn't claim one. */
export function describeSignal(signal: Signal): string {
  const tactic = TACTICS.find((t) => t.id === signal.tactic)!;
  const sure = signal.via === "pattern" || isDecisive(signal);
  return sure ? tactic.label : `Possibly: ${tactic.label.toLowerCase()}`;
}

export class Detector {
  private index: ExemplarIndex | null = null;
  private embed: Embedder | null;
  private config: SemanticConfig;
  private state: CallState = { score: 0, level: 0, seen: [] };

  constructor(embed: Embedder | null = null, config: SemanticConfig = DEFAULT_SEMANTIC) {
    this.embed = embed;
    this.config = config;
  }

  /** Embeds the example sentences once. Skipped when running on patterns alone. */
  async prepare(): Promise<void> {
    if (!this.embed || this.index) return;
    const byTactic = new Map<TacticId, number[][]>();
    // A tactic with no examples is matched by its patterns alone. The model rejects an empty batch.
    for (const tactic of TACTICS) byTactic.set(tactic.id, tactic.exemplars.length ? await this.embed(tactic.exemplars) : []);
    this.index = { byTactic, safe: await this.embed(SAFE_EXEMPLARS) };
  }

  reset(): void {
    this.state = { score: 0, level: 0, seen: [] };
  }

  get current(): CallState {
    return this.state;
  }

  /**
   * Adds a piece of caller speech and returns any tactics seen for the first time.
   *
   * The score only ever goes up. A caller cannot talk it back down, because any
   * reassurance a genuine caller might give is exactly what a scammer would say too.
   */
  async hear(text: string): Promise<Signal[]> {
    const clauses = splitClauses(text);
    const fresh: Signal[] = [];
    const seen = new Map(this.state.seen.map((s) => [s.tactic, s]));

    const add = (signal: Signal) => {
      const earlier = seen.get(signal.tactic);
      // A tactic counts once, but an explicit ask must still replace an earlier lookalike of itself.
      if (earlier && (isDecisive(earlier) || !isDecisive(signal))) return;
      seen.set(signal.tactic, signal);
      const sameTurn = fresh.findIndex((f) => f.tactic === signal.tactic);
      if (sameTurn >= 0) fresh.splice(sameTurn, 1);
      fresh.push(signal);
    };

    for (const clause of clauses) {
      for (const tactic of matchPatterns(clause)) add({ tactic: tactic.id, evidence: clause, via: "pattern" });
    }

    if (this.embed && this.index && clauses.length > 0) {
      // Patterns need no model, so if the model fails, what they found still counts.
      const vectors = await this.embed(clauses).catch(() => null);
      vectors?.forEach((vector, i) => {
        const clause = clauses[i];
        const isProtective = PROTECTIVE_WORDING.test(clause);
        const safeSim = topKMean(vector, this.index!.safe);
        for (const tactic of TACTICS) {
          const examples = this.index!.byTactic.get(tactic.id)!;
          if (examples.length === 0 || (tactic.guarded && isProtective) || tactic.except?.test(clause)) continue;
          const sim = topKMean(vector, examples);
          if (sim >= this.config.threshold && sim - safeSim >= this.config.margin) {
            add({ tactic: tactic.id, evidence: clause, via: "semantic", similarity: sim });
          }
        }
      });
    }

    if (fresh.length > 0) {
      const all = [...this.state.seen.filter((s) => !fresh.some((f) => f.tactic === s.tactic)), ...fresh];
      this.state = { seen: all, ...scoreSignals(all) };
    }
    return fresh;
  }
}

export function scoreSignals(signals: Signal[]): { score: number; level: RiskLevel } {
  const weightOf = (s: Signal) => {
    const tactic = TACTICS.find((t) => t.id === s.tactic)!;
    return tactic.decisive && !isDecisive(s) ? LOOKALIKE_WEIGHT : tactic.weight;
  };
  const score = signals.reduce((sum, s) => sum + weightOf(s), 0);
  let level: RiskLevel = 0;
  if (score >= 1) level = 1;
  if (score >= WARN_SCORE) level = 2;
  // Adding up can say "hang up" only with something explicit in the mix, so similarity alone stays a warning.
  if (signals.some(isDecisive) || (score >= GET_OUT_SCORE && signals.some((s) => s.via === "pattern"))) level = 3;
  return { score, level };
}
