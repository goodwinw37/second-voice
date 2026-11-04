// Decides whether the coach speaks, and what it says.
//
// Pure logic: given what has been heard, return a line or stay silent. The rules
// below exist because a coach that talks too much is a coach people switch off.

import { TACTICS, type TacticId } from "../detect/tactics.ts";
import { isDecisive, type CallState, type RiskLevel, type Signal } from "../detect/detector.ts";
import type { LineId } from "./lines.ts";

export type UserIntent =
  | "ask_is_real"
  | "ask_what_to_say"
  | "ask_unclear"
  | "hang_up"
  | "disclosure"
  | "resist"
  | "comply"
  | "other";

/** The speech model can mishear the wake word, so its usual mistakes count too. */
const ADDRESSES_COACH =
  /^\W*((hey|hi|ok|okay|oh|um|so|excuse me)\W+)?(coach|couch|coat|cooch|gooch)(,|\.|!|\?|\s*$|\s+(is (this|that|it|he|she|they)|are they|what|should|hang|help|how|can i|do i))|,\s*coach\W*$/i;
const MAX_COMMAND_WORDS = 7;
const BARE_HANG_UP = /^\W*(please\W+)?hang\W+up(\W+now)?\W*$/i;

/**
 * Whether this is clearly the person giving the coach a command. Listen mode relies on this,
 * because one microphone hears both people. "Hang up" on its own stays, because the coach
 * tells people to hang up. A caller could say it too, and that is a limit of one microphone.
 */
export function isCommandToCoach(text: string): boolean {
  // A real command is short. "Coach, you need to buy gift cards" is a caller, and has to reach the detector.
  if (text.trim().split(/\s+/).length > MAX_COMMAND_WORDS) return false;
  return ADDRESSES_COACH.test(text) || BARE_HANG_UP.test(text);
}

/** Digits read aloud, in figures or as words. "Oh" isn't here: it would turn panic into a read-out. */
const DIGIT_WORD = /\b(zero|nought|one|two|three|four|five|six|seven|eight|nine|double|treble|triple|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi;
/** Words people say around a number they're reading out. */
const AROUND_DIGITS = /\b(okay|ok|yes|yeah|right|so|um|er|erm|and|then|it'?s|its|it is|that'?s|the|code|number|pin|is|are|sorry|it says|i'?ve got|hang on|hold on)\b/gi;
/** Amounts, times and places. Moonshine writes these as figures, and they aren't codes being read out. */
const NOT_A_CODE = /[£$€%]|\b\d{1,2}:\d{2}\b|\b\d+\/\d+\b|\b(pounds?|quid|pence|percent|per cent|am|pm|o'?clock|past|hundred|thousand|tomorrow|today|tonight|ring|call|dial|in|since|at|flat|room|bus|road|street)\b/i;
const NAMING_A_SECRET =
  /\b(my|the)\s+(pin|password|passcode|code|card number|sort code|account number|security code|security number)('s\b|\s+is\b|\s+are\b|\s+number is\b)(?!\s+(private|secret|safe|none|not|on|in|under|at|written|somewhere|hidden|mine|wrong|expired|invalid|incorrect|broken|useless|what|nothing|my|with|for|the|something|different|locked|blocked)\b)/i;

/**
 * Whether someone seems to be reading out a number. It has to be mostly digits:
 * "I was born in 1962" and "one dog, two cats and three fish" aren't read-outs, but "472" is,
 * and codes do get read in groups of three.
 */
export function isDisclosure(text: string): boolean {
  if (NAMING_A_SECRET.test(text)) return true;
  if (NOT_A_CODE.test(text)) return false;
  const digits = (text.match(/\d/g) ?? []).length + (text.match(DIGIT_WORD) ?? []).length;
  if (digits < 3) return false;
  const otherWords = text.replace(DIGIT_WORD, " ").replace(AROUND_DIGITS, " ").match(/[a-z']+/gi) ?? [];
  return otherWords.length <= 1;
}

/** A chunk that's only digits, however few. A code read a digit at a time arrives like this. */
export function isDigitsOnly(text: string): boolean {
  const digits = (text.match(/\d/g) ?? []).length + (text.match(DIGIT_WORD) ?? []).length;
  if (digits === 0) return false;
  return (text.replace(DIGIT_WORD, " ").replace(AROUND_DIGITS, " ").match(/[a-z']+/gi) ?? []).length === 0;
}

const RESIST =
  /\b(call (you |them )?back|ring (you |them )?back|number on (the back of )?my card|number i trust|official number|usual number|not (paying|interested|giving|comfortable|sending|doing|telling|reading)|don'?t give that|won'?t (give|pay|send|do|read|tell)|no thank(s| you)?|not today|get it checked|check (this|that|it) myself|(?<!oh,? )no(?! problem| worries)|nope|can'?t|cannot|will not|will never|never|don'?t (believe|trust)|doesn'?t (sound|seem|feel) right|absolutely not|no way|rather not|ring my bank|go to the branch|call(ing)? the police)\b/i;
/** Anchored to the start, so "That doesn't sound right" isn't agreement because it contains "right". */
const COMPLY = /^\W*(oh no\W+)?(ok(ay)?|alright|all right|yes|yeah|sure|right|of course|fine|i will|i can\b(?!'t)|i'?ll do|what do i do|what do you need|tell me what|go on)\b/i;
const LEAVING = /\b(hang(ing)? up|end(ing)? (the|this) call|cut(ting)? (it|them|you) off|put(ting)? the phone down)\b|\bi'?m going now\W*$|(?<!said )\b(good)?bye\b(?! to| for(?! now))/i;
/** "Don't hang up", "Should I hang up?" and "hang up my coat" aren't someone leaving. */
const NOT_LEAVING =
  /\b(don'?t|do not|won'?t|will not|not|never|can'?t|did (you|they|he|she)|should i|shall i|could i|can i|what if|if (i|you))\b.{0,20}\b(hang(ing)? up|end(ing)? (the|this) call|put(ting)? the phone down)\b|\bhang(ing)? up (my|the|your|a|some)\b/i;
const ASK_REAL = /\b(is (this|that|it|he|she|they) (real|genuine|legit|legitimate|a scam|safe|okay|ok|lying)|are they (real|genuine|lying)|scam|should i (trust|believe)|what do you think|can i trust|(this|that) person)\b/i;
const ASK_SAY = /\b(what (do|should|can) i (say|do|tell)|what to say|help me|how do i (get out|end)|what now|should i (hang up|give))\b/i;

/** Works out what the person meant. Order matters: safety first. */
export function classifyUser(text: string): UserIntent {
  if (isDisclosure(text)) return "disclosure";
  if (LEAVING.test(text) && !NOT_LEAVING.test(text)) return "hang_up";
  if (ADDRESSES_COACH.test(text)) {
    if (ASK_REAL.test(text)) return "ask_is_real";
    if (ASK_SAY.test(text)) return "ask_what_to_say";
    return "ask_unclear";
  }
  if (RESIST.test(text)) return "resist";
  if (COMPLY.test(text)) return "comply";
  return "other";
}

export interface Utterance {
  line: LineId;
  /** Urgent lines interrupt the caller. Others wait for a natural pause. */
  urgent: boolean;
  tactic?: TacticId;
}

const MIN_GAP_MS = 7000;
const tacticOf = (signal: Signal) => TACTICS.find((t) => t.id === signal.tactic)!;

export class Coach {
  private lastSpokeAt = -Infinity;
  private lastLevelSpoken: RiskLevel = 0;
  private spoken = new Set<LineId>();
  private pushedBackAt = -Infinity;

  reset(): void {
    this.lastSpokeAt = -Infinity;
    this.lastLevelSpoken = 0;
    this.spoken.clear();
    this.pushedBackAt = -Infinity;
  }

  private say(line: LineId, urgent: boolean, now: number, tactic?: TacticId): Utterance {
    this.lastSpokeAt = now;
    this.spoken.add(line);
    return { line, urgent, tactic };
  }

  /** Called whenever the caller says something. Returns a line, or null to stay silent. */
  afterCaller(fresh: Signal[], state: CallState, now: number): Utterance | null {
    if (state.level < 2) return null;

    // A decisive red flag always gets through, however recently the coach spoke.
    const decisive = fresh.filter((s) => isDecisive(s)).map(tacticOf).find((t) => !this.spoken.has(t.id));
    if (decisive) {
      this.lastLevelSpoken = 3;
      return this.say(decisive.id, true, now, decisive.id);
    }

    // So does the moment it adds up to "hang up", or that warning could be lost.
    if (state.level === 3 && this.lastLevelSpoken < 3) {
      this.lastLevelSpoken = 3;
      // Not urgent straight after the pushback line, so it doesn't cut that off.
      return this.say("get_out", now - this.pushedBackAt >= MIN_GAP_MS, now);
    }

    // Otherwise, leave a gap so the person can still follow the conversation.
    if (now - this.lastSpokeAt < MIN_GAP_MS && this.lastLevelSpoken >= 2) return null;

    // Name the most serious new tactic, which is more useful than a generic warning. A lookalike of
    // a decisive tactic can't be named: that line says "hang up now" and states what was asked for.
    const nameable = fresh.map(tacticOf).filter((t) => !t.decisive);
    const newest = nameable.sort((a, b) => b.weight - a.weight)[0];
    if (newest && !this.spoken.has(newest.id)) {
      this.lastLevelSpoken = Math.max(this.lastLevelSpoken, 2) as RiskLevel;
      return this.say(newest.id, false, now, newest.id);
    }

    // Warn at least once when mild tactics have added up with no new one to name.
    if (this.lastLevelSpoken < 2) {
      const heaviest = state.seen
        .map(tacticOf)
        .filter((t) => !t.decisive)
        .sort((a, b) => b.weight - a.weight)
        .find((t) => !this.spoken.has(t.id));
      this.lastLevelSpoken = 2;
      return heaviest ? this.say(heaviest.id, false, now, heaviest.id) : this.say("warn_generic", false, now);
    }
    return null;
  }

  /** Called whenever the person says something. */
  afterUser(intent: UserIntent, state: CallState, now: number): Utterance | null {
    switch (intent) {
      case "disclosure":
        // Only interrupt someone reading out numbers if the call has given cause for concern.
        // People read out phone numbers and appointment times on ordinary calls all the time.
        return state.level >= 1 ? this.say("disclosure_stop", true, now) : null;
      case "ask_is_real":
        if (state.level >= 2) return this.say("answer_worried", true, now);
        return this.say(state.seen.length > 0 ? "answer_one_thing" : "answer_nothing_yet", true, now);
      case "ask_what_to_say":
        return this.say("answer_what_to_say", true, now);
      case "ask_unclear":
        // Not urgent: a misheard "coach" mustn't cut off the only line telling them to hang up.
        return this.say("answer_unsure", false, now);
      default:
        return null;
    }
  }

  /** Called when the caller keeps pressing after the person tried to leave. */
  afterPushback(now: number): Utterance | null {
    if (this.spoken.has("pushback")) return null;
    // Only a warning: this line no longer says "hang up now", so a later get_out must still play.
    this.lastLevelSpoken = Math.max(this.lastLevelSpoken, 2) as RiskLevel;
    this.pushedBackAt = now;
    return this.say("pushback", true, now);
  }
}
