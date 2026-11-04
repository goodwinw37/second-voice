// One call, from start to finish. This is where the pieces meet:
//
//   audio → segmenter → speech recognition → detector → coach → audio
//
// The caller and the person each have their own channel, and everything the coach warns
// about comes from recognised speech on those channels. The one thing a practice call takes
// from its script is knowing when the caller is pressing on after the person tried to leave.

import { AudioEngine } from "../audio/engine.ts";
import { SAMPLE_RATE } from "../audio/engine.ts";
import { Segmenter, type Chunk } from "../audio/segmenter.ts";
import { clipId, type Scenario, type Step } from "../call/scenarios.ts";
import { Coach, classifyUser, isCommandToCoach, isDigitsOnly, isDisclosure, type Utterance, type UserIntent } from "../coach/coach.ts";
import { LINES, type LineId } from "../coach/lines.ts";
import { Detector, describeSignal, stitch, unfinishedTail, type Embedder, type RiskLevel, type Signal } from "../detect/detector.ts";
import type { SpeechClient } from "../speech/client.ts";

export type Mode = "demo" | "mic" | "listen";
export type Speaker = "caller" | "you";

export type SessionEvent =
  | { type: "status"; text: string }
  | { type: "transcript"; who: Speaker; text: string; asrMs: number }
  | { type: "signal"; signal: Signal; label: string }
  | { type: "level"; level: RiskLevel; score: number }
  | { type: "intent"; intent: UserIntent; text: string }
  | { type: "coach"; line: string; text: string; sayThis?: string; urgent: boolean; latencyMs: number | null }
  /** Something the person needs to know that isn't advice about the call. Never spoken. */
  | { type: "notice"; text: string }
  /** `clean` means nothing at all stood out. `heardProperly` is false if speech recognition or the mic failed. */
  | { type: "ended"; level: RiskLevel; signals: Signal[]; latencies: number[]; clean: boolean; heardProperly: boolean };

const REPLY_WAIT_MS = 7000;
/** The most extra time to allow if someone is still talking when the wait runs out. */
const REPLY_EXTRA_MS = 6000;
/** How long to wait for more, once someone has given what might be only the start of an answer. */
const REPLY_PAUSE_MS = 600;
const DEMO_REPLY_GAP_MS = 700;
/** On loudspeakers, the mic hears what we play. A chunk this similar to it is treated as echo. */
const ECHO_OVERLAP = 0.7;
const ECHO_TAIL_MS = 1500;
/** Listen mode has no separate caller channel, so a pause has to be heard rather than known. */
const QUIET_BEFORE_SPEAKING_MS = 800;
/** Hanging up must always work, even if a speech model has got stuck. */
const HANG_UP_WAIT_MS = 1500;
/** Someone reading a code a digit at a time leaves longer gaps than a normal pause. */
const DIGIT_GAP_MS = 2000;
/** The longest a non-urgent line waits for a pause, because a TV or a long speech may never give one. */
const LONGEST_WAIT_MS = 6000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Speech models can write these for silence and background noise. They aren't speech. */
function cleanTranscript(text: string): string {
  // The speech model writes old-fashioned "to-day", which would stop patterns matching.
  const cleaned = text.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, "").replace(/\bto-(night|day|morrow)\b/gi, "to$1").trim();
  return /^[\s.,!?-]*$/.test(cleaned) ? "" : cleaned;
}

const wordsOf = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);

const DIRECT_INTENTS: ReadonlySet<UserIntent> = new Set(["ask_is_real", "ask_what_to_say", "ask_unclear", "disclosure"]);

export class Session {
  private detector: Detector;
  private coach = new Coach();
  private engine = new AudioEngine();
  private callerSegmenter: Segmenter;
  private youSegmenter: Segmenter;
  private callerTail = "";
  private latencies: number[] = [];
  private pendingWork = new Set<Promise<void>>();
  private pendingCoach: { utterance: Utterance; heardAt: number } | null = null;
  private coachPlaying: Promise<void> = Promise.resolve();
  private ended = false;
  private pushbackStep = false;
  private replyWaiter: ((text: string | null) => void) | null = null;
  private youHeardAt = 0;
  private earlyReply: string | null = null;
  private playedAloud: Array<{ words: Set<string>; until: number }> = [];
  private serial: Promise<void> = Promise.resolve();
  private heardReadOut = false;
  private heardProperly = true;
  private pauseWatcher: ReturnType<typeof setInterval> | undefined;
  private waitingForRest = false;
  private digitRun = "";
  private digitRunAt = -Infinity;
  private speech: SpeechClient;
  get isListening(): boolean {
    return this.mode === "listen";
  }
  private mode: Mode;
  private scenario: Scenario | null;
  private emit: (event: SessionEvent) => void;

  constructor(
    speech: SpeechClient,
    mode: Mode,
    scenario: Scenario | null,
    emit: (event: SessionEvent) => void,
  ) {
    this.speech = speech;
    this.mode = mode;
    this.scenario = scenario;
    this.emit = emit;
    const embed: Embedder = async (texts) => {
      try {
        return await speech.embed(texts);
      } catch (error) {
        this.noteTrouble("Speech matching failed, so the coach may miss things on this call.");
        throw error;
      }
    };
    this.detector = new Detector(embed);
    this.callerSegmenter = new Segmenter({ sampleRate: SAMPLE_RATE, pauseMs: 280, maxChunkMs: 6000 }, (c) => this.onChunk("caller", c));
    this.youSegmenter = new Segmenter({ sampleRate: SAMPLE_RATE, maxChunkMs: 2500 }, (c) => this.onChunk("you", c));
  }

  async start(): Promise<void> {
    // The person can press the button at any moment, so check after everything that takes time.
    await this.detector.prepare();
    if (this.ended) return;
    await this.engine.start();
    if (this.ended) return;
    await this.engine.preload(Object.keys(LINES).map((id) => `coach-${id}`));
    if (this.ended) return;

    // Always listening. Someone may need to say "hang up" while another voice is talking.
    this.engine.onCallerFrame = (frame) => this.callerSegmenter.push(frame);
    this.engine.onYouFrame = (frame) => this.youSegmenter.push(frame);
    this.engine.onMicLost = () => this.noteTrouble("The microphone stopped, so the coach can't hear this any more.");

    if (this.mode === "listen") {
      await this.engine.openMic();
      if (this.ended) return this.engine.stopMic();
      this.engine.routeMicTo("caller");
      this.emit({ type: "status", text: "Listening" });
      this.watchForPauses();
      return; // Runs until the person ends it.
    }

    if (this.mode === "mic") {
      await this.engine.openMic();
      if (this.ended) return this.engine.stopMic();
      this.engine.routeMicTo("you");
    }
    await this.runScript(this.scenario!);
  }

  /** Ends the call, from a button or from the person saying "hang up". */
  async hangUp(fromButton = false): Promise<void> {
    if (this.ended) {
      // A second press skips the closing line. Words still being transcribed must not skip it.
      if (fromButton) this.engine.stopCoach();
      return;
    }
    // Speech still being collected counts: the person may be hanging up because of what was just said.
    this.callerSegmenter.flush();
    this.youSegmenter.flush();
    this.ended = true;
    this.engine.onCallerFrame = () => {};
    this.engine.onYouFrame = () => {};
    clearInterval(this.pauseWatcher);
    this.engine.stopCaller();
    this.engine.stopYou();
    this.engine.stopMic();
    this.pendingCoach = null;
    this.replyWaiter?.(null);
    this.emit({ type: "status", text: "Call ended" });

    await Promise.race([Promise.allSettled([...this.pendingWork]), sleep(HANG_UP_WAIT_MS)]);
    // Something still unheard means this can't say the call was fine.
    if (this.pendingWork.size > 0) this.heardProperly = false;

    const { level, seen } = this.detector.current;
    const family = seen.some((s) => s.tactic === "family_emergency");
    const clean = seen.length === 0 && !this.heardReadOut && this.heardProperly;
    const closing: LineId = level >= 2 ? (family ? "ended_family" : "ended_safely") : clean ? "ended_clean" : "ended_unsure";
    this.emit({ type: "coach", line: closing, text: LINES[closing].text, urgent: true, latencyMs: null });
    try {
      // Bounded, because a suspended audio context never reports that a clip has finished.
      const clipMs = this.engine.clipSeconds(`coach-${closing}`) * 1000;
      await Promise.race([this.engine.playCoach(`coach-${closing}`), sleep(clipMs + 1000)]);
    } catch {
      // The clip isn't loaded, because they hung up straight away. There's nothing to play, but the call still ends.
    }
    // Anything that arrived during the closing line still counts.
    const final = this.detector.current;
    const cleanAtEnd = final.seen.length === 0 && !this.heardReadOut && this.heardProperly;
    this.emit({ type: "ended", level: final.level, signals: final.seen, latencies: this.latencies, clean: cleanAtEnd, heardProperly: this.heardProperly });
    await this.engine.close();
  }

  /** Stops without a closing line, for when the call never got going. */
  async abort(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.pauseWatcher);
    this.replyWaiter?.(null);
    await this.engine.close();
  }

  // ---- The scripted call ----------------------------------------------------

  private async runScript(scenario: Scenario): Promise<void> {
    const steps = new Map(scenario.steps.map((step) => [step.id, step]));
    const clips = scenario.steps.flatMap((step) => [
      clipId(scenario.id, step.id, "caller"),
      ...(this.mode === "demo" ? (step.demoReplies ?? []).map((_, i) => clipId(scenario.id, step.id, `you${i}`)) : []),
    ]);
    await this.engine.preload(clips);

    let step: Step | undefined = scenario.steps[0];
    while (step && !this.ended) {
      this.emit({ type: "status", text: "Caller speaking" });
      this.pushbackStep = !!step.pushback;
      await this.trackPlayback(step.text, this.engine.playCaller(clipId(scenario.id, step.id, "caller")));
      if (this.ended) return;
      this.callerSegmenter.flush();
      await this.settle();
      if (this.ended) return;
      if (step.ends) {
        break;
      }
      const intent = await this.getReply(scenario, step);
      if (this.ended) return;
      const route: string | undefined =
        intent === "resist" ? step.next.resist : intent === null ? step.next.silence : step.next.comply;
      step = route ? steps.get(route) : undefined;
    }
    if (!this.ended) await this.hangUp();
  }

  /** Waits for the person to answer. Questions to the coach don't count as an answer to the caller. */
  private async getReply(scenario: Scenario, step: Step): Promise<UserIntent | null> {
    const replies = this.mode === "demo" ? step.demoReplies ?? [] : null;
    let attempt = 0;
    while (!this.ended) {
      this.emit({ type: "status", text: "Your turn" });
      const first = await this.listenForReply(scenario, step, replies, attempt);
      attempt++;
      if (this.ended) return null;
      if (first === null) return null;
      this.waitingForRest = true;
      const text = await this.restOfReply(first);
      this.waitingForRest = false;
      if (this.ended) return null;
      const intent = classifyUser(text);
      this.emit({ type: "intent", intent, text });
      if (intent === "hang_up") {
        await this.hangUp();
        return null;
      }
      if (intent === "disclosure") this.heardReadOut = true;
      const reaction = this.coach.afterUser(intent, this.detector.current, performance.now());
      if (reaction) this.speak(reaction, this.youHeardAt);
      await this.settle();
      const talkingToCoach = intent === "ask_is_real" || intent === "ask_what_to_say" || intent === "ask_unclear";
      if (talkingToCoach || intent === "disclosure") continue;
      return intent;
    }
    return null;
  }

  /** People pause mid-answer. "Oh, I'm not sure. I'll call you back." is one answer, not two. */
  private async restOfReply(first: string): Promise<string> {
    const intent = classifyUser(first);
    if (this.mode !== "mic" || (intent !== "comply" && intent !== "other" && intent !== "resist")) return first;
    const giveUpAt = performance.now() + REPLY_EXTRA_MS;
    const soFar = () => (this.earlyReply ? `${first} ${this.earlyReply}` : first);
    const stillGoing = () =>
      this.youSegmenter.inSpeech || this.pendingWork.size > 0 || (isDigitsOnly(soFar()) && performance.now() - this.youHeardAt < DIGIT_GAP_MS);
    do {
      await sleep(REPLY_PAUSE_MS);
      // Stop as soon as it's clearly a code, because the whole point is to interrupt it.
    } while (!this.ended && !isDisclosure(soFar()) && stillGoing() && performance.now() < giveUpAt);
    const reply = soFar();
    this.earlyReply = null;
    return reply;
  }

  private listenForReply(scenario: Scenario, step: Step, replies: string[] | null, attempt: number): Promise<string | null> {
    if (this.earlyReply) {
      const reply = this.earlyReply;
      this.earlyReply = null;
      return Promise.resolve(reply);
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.replyWaiter = (text) => {
        clearTimeout(timer);
        this.replyWaiter = null;
        resolve(text);
      };
      if (replies) {
        if (attempt >= replies.length) {
          this.replyWaiter(null);
          return;
        }
        void sleep(DEMO_REPLY_GAP_MS).then(async () => {
          if (this.ended) return;
          await this.engine.playYou(clipId(scenario.id, step.id, `you${attempt}`));
          this.youSegmenter.flush();
        });
      }
      const giveUpAt = performance.now() + REPLY_WAIT_MS + REPLY_EXTRA_MS;
      const expire = () => {
        // Don't take silence for an answer while someone is still in the middle of a sentence.
        const stillTalking = !replies && (this.youSegmenter.inSpeech || this.pendingWork.size > 0);
        if (stillTalking && performance.now() < giveUpAt) timer = setTimeout(expire, 300);
        else this.replyWaiter?.(null);
      };
      // In hands-free mode the reply is on its way, so allow plenty of time for it.
      timer = setTimeout(expire, replies ? REPLY_WAIT_MS * 3 : REPLY_WAIT_MS);
    });
  }

  // ---- Speech → decisions ---------------------------------------------------

  /** Waits until everything heard so far has been processed and the coach has finished. */
  private async settle(): Promise<void> {
    // The check on `ended` is what keeps this from freezing the tab. The closing line sets
    // coachSpeaking, and the promises awaited here have already resolved, so without it this
    // would spin without ever letting the browser report that the clip had finished.
    while (!this.ended && (this.pendingWork.size > 0 || this.engine.coachSpeaking || this.pendingCoach)) {
      await Promise.allSettled([...this.pendingWork]);
      await this.coachPlaying;
      this.flushPendingCoach();
      await this.coachPlaying;
    }
  }

  private noteTrouble(text: string): void {
    if (this.heardProperly) this.emit({ type: "notice", text });
    this.heardProperly = false;
  }

  private onChunk(who: Speaker, chunk: Chunk): void {
    const heardAt = performance.now() - chunk.trailingSilenceMs;
    const work = (async () => {
      let transcript: { text: string; ms: number };
      try {
        transcript = await this.speech.transcribe(chunk.samples);
      } catch {
        this.noteTrouble("Speech recognition failed, so the coach may miss things on this call.");
        return;
      }
      const text = cleanTranscript(transcript.text);
      if (!text) return;
      if (this.isEcho(who, text)) return;
      this.emit({ type: "transcript", who, text, asrMs: transcript.ms });
      // One at a time, in the order they were heard.
      const turn = this.serial.then(() => (who === "caller" ? this.onCallerText(text, heardAt) : this.onYouText(text, heardAt)));
      this.serial = turn.catch(() => {});
      await turn;
    })();
    this.pendingWork.add(work);
    void work.finally(() => this.pendingWork.delete(work));
  }

  private async onCallerText(text: string, heardAt: number): Promise<void> {
    // In listen mode one microphone hears both people and can't tell them apart. Only a clear
    // command counts as the person, because a scammer's "don't hang up" must never end this.
    if (this.mode === "listen" && isCommandToCoach(text) && this.handleDirect(text, heardAt)) return;

    const heard = stitch(this.callerTail, text);
    this.callerTail = unfinishedTail(heard);

    const before = this.detector.current.level;
    const fresh = await this.detector.hear(heard);
    for (const signal of fresh) this.emit({ type: "signal", signal, label: describeSignal(signal) });
    const state = this.detector.current;
    if (state.level !== before) this.emit({ type: "level", level: state.level, score: state.score });

    const now = performance.now();
    let utterance: Utterance | null = null;
    if (this.pushbackStep) {
      this.pushbackStep = false;
      if (state.level >= 1) utterance = this.coach.afterPushback(now);
    }
    utterance ??= this.coach.afterCaller(fresh, state, now);
    // It could be either person reading out those digits, so only speak if nothing more specific applies.
    if (!utterance && this.mode === "listen" && this.readingOut(text)) {
      this.heardReadOut = true;
      utterance = this.coach.afterUser("disclosure", state, now);
    }
    if (utterance) this.speak(utterance, heardAt);
  }

  /** One microphone hears a code read a digit at a time as separate chunks, so recent ones count together. */
  private readingOut(text: string): boolean {
    const now = performance.now();
    if (isDisclosure(text)) {
      this.digitRun = "";
      return true;
    }
    if (!isDigitsOnly(text) || now - this.digitRunAt > DIGIT_GAP_MS) this.digitRun = "";
    if (isDigitsOnly(text)) {
      this.digitRun += ` ${text}`;
      this.digitRunAt = now;
    }
    if (!isDisclosure(this.digitRun)) return false;
    this.digitRun = "";
    return true;
  }

  private async onYouText(text: string, heardAt: number): Promise<void> {
    this.youHeardAt = heardAt;
    if (this.replyWaiter) return this.replyWaiter(text);
    // They spoke while another voice was talking. Act now if it can't wait, otherwise
    // keep it as their answer for when the caller finishes.
    if (this.handleDirect(text, heardAt)) return;
    this.earlyReply = this.earlyReply ? `${this.earlyReply} ${text}` : text;
    // Digits read one at a time only look like a read-out once they're joined up.
    if (!this.waitingForRest && isDisclosure(this.earlyReply) && this.handleDirect(this.earlyReply, heardAt)) this.earlyReply = null;
  }

  /** Handles anything that can't wait for a turn: hanging up, asking the coach, reading out numbers. */
  private handleDirect(text: string, heardAt: number): boolean {
    const intent = classifyUser(text);
    if (intent === "hang_up") {
      this.emit({ type: "intent", intent, text });
      void this.hangUp();
      return true;
    }
    if (!DIRECT_INTENTS.has(intent)) return false;
    if (intent === "disclosure") this.heardReadOut = true;
    this.emit({ type: "intent", intent, text });
    const reaction = this.coach.afterUser(intent, this.detector.current, performance.now());
    if (reaction) this.speak(reaction, heardAt);
    return true;
  }

  /** True if this chunk is just the mic hearing what we are playing, on a laptop with no headphones. */
  private isEcho(who: Speaker, text: string): boolean {
    if (this.mode === "demo") return false;
    if (who === "caller" && this.mode !== "listen") return false;
    // A practice call gives the person their own channel, and "hang up" is often in what's being
    // played. Word overlap can't separate echo from someone obeying the coach, so always believe it.
    // The worst case is a practice call ended early, which is the safe way to get this wrong.
    if (this.mode === "mic" && classifyUser(text) === "hang_up" && text.trim().split(/\s+/).length <= 5) return false;
    const now = performance.now();
    // On loudspeakers the coach's "Say: ..." comes back as a chunk starting "Say". Someone repeating it wouldn't say that.
    if (who === "you" && /^\W*say\b/i.test(text) && this.playedAloud.some((entry) => entry.until > now)) return true;
    const words = wordsOf(text);
    this.playedAloud = this.playedAloud.filter((entry) => entry.until > now);
    return this.playedAloud.some((entry) => {
      const shared = [...words].filter((word) => entry.words.has(word)).length;
      return words.size > 0 && shared / words.size >= ECHO_OVERLAP;
    });
  }

  private trackPlayback(text: string, playing: Promise<void>): Promise<void> {
    const entry = { words: wordsOf(text), until: Infinity };
    this.playedAloud.push(entry);
    return playing.then(() => {
      entry.until = performance.now() + ECHO_TAIL_MS;
    });
  }

  // ---- Speaking ---------------------------------------------------------------

  /** Urgent lines play now. Others wait for the caller to pause, so the person isn't talked over. */
  private speak(utterance: Utterance, heardAt: number): void {
    if (utterance.urgent) {
      this.pendingCoach = null; // Anything queued is now out of date.
      this.playLine(utterance, heardAt);
    } else if (this.mode === "listen" || this.engine.callerSpeaking || this.engine.coachSpeaking) {
      this.pendingCoach = { utterance, heardAt };
    } else {
      this.playLine(utterance, heardAt);
    }
  }

  /** Listen mode plays waiting lines here. A practice call does it between the caller's lines. */
  private watchForPauses(): void {
    let lastSpeech = performance.now();
    this.pauseWatcher = setInterval(() => {
      const now = performance.now();
      if (this.callerSegmenter.inSpeech) lastSpeech = now;
      if (!this.pendingCoach || this.engine.coachSpeaking) return;
      if (now - lastSpeech >= QUIET_BEFORE_SPEAKING_MS || now - this.pendingCoach.heardAt >= LONGEST_WAIT_MS) this.flushPendingCoach();
    }, 100);
  }

  private flushPendingCoach(): void {
    if (!this.pendingCoach) return;
    const { utterance, heardAt } = this.pendingCoach;
    this.pendingCoach = null;
    this.playLine(utterance, heardAt);
  }

  private playLine(utterance: Utterance, heardAt: number): void {
    if (this.ended) return;
    const latencyMs = Math.round(performance.now() - heardAt);
    if (utterance.urgent) this.latencies.push(latencyMs);
    const line = LINES[utterance.line];
    this.emit({
      type: "coach",
      line: utterance.line,
      text: line.text,
      sayThis: line.sayThis,
      urgent: utterance.urgent,
      latencyMs: utterance.urgent ? latencyMs : null,
    });
    // An "okay" said over the caller isn't an answer to what the coach is about to suggest.
    if (this.earlyReply && classifyUser(this.earlyReply) !== "resist") this.earlyReply = null;
    // The words it suggests saying aren't treated as echo, because the person is meant to repeat them.
    const echoable = line.sayThis ? line.text.replace(line.sayThis, "") : line.text;
    this.coachPlaying = this.trackPlayback(echoable, this.engine.playCoach(`coach-${utterance.line}`));
  }
}
