import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { Detector, describeSignal, scoreSignals, matchPatterns, stitch, unfinishedTail, type Signal } from "../src/detect/detector.ts";
import { Coach, classifyUser, isCommandToCoach, isDigitsOnly, isDisclosure } from "../src/coach/coach.ts";
import { LINES } from "../src/coach/lines.ts";
import { TACTICS } from "../src/detect/tactics.ts";
import { SCENARIOS } from "../src/call/scenarios.ts";
import { Segmenter, type Chunk } from "../src/audio/segmenter.ts";

const tacticsIn = (text: string) => matchPatterns(text).map((t) => t.id);
const signal = (tactic: Signal["tactic"]): Signal => ({ tactic, evidence: "", via: "pattern" });

describe("detecting tactics", () => {
  it("spots the classic asks", () => {
    expect(tacticsIn("Please read that code out to me.")).toContain("credentials");
    expect(tacticsIn("You need to transfer your savings to a safe account.")).toContain("safe_account");
    expect(tacticsIn("Do not tell anyone about this call, not even the staff at your bank.")).toContain("secrecy");
    expect(tacticsIn("Download AnyDesk so that I can help you.")).toContain("remote_access");
    expect(tacticsIn("If the cashier asks, say it's for home improvements.")).toContain("coached_lie");
  });

  it("does not treat protective advice as an ask", () => {
    expect(tacticsIn("We will never ask for your PIN or your full password.")).toEqual([]);
    expect(tacticsIn("Never share this code with anyone.")).not.toContain("credentials");
  });

  it("is not fooled when the speech model spells out PIN", async () => {
    // A real failure: "P. I. N." split the sentence, and a genuine bank call got a "hang up".
    const detector = new Detector();
    await detector.hear("We will never ask for your P. I. N. or your full password, and I won't ask you to move any money.");
    expect(detector.current.level).toBe(0);
  });

  it("does not treat a bare mention of a password as a request", () => {
    expect(tacticsIn("Your password was changed yesterday.")).not.toContain("credentials");
    expect(tacticsIn("I need your PIN.")).toContain("credentials");
  });

  it("still catches an ask that follows reassurance", async () => {
    const detector = new Detector();
    await detector.hear("We will never ask for your PIN, but please read back the code we sent you.");
    expect(detector.current.seen.map((s) => s.tactic)).toContain("credentials");
  });

  it("leaves ordinary sales language alone", () => {
    expect(tacticsIn("It's a one-time payment of two hundred pounds.")).not.toContain("advance_fee");
    expect(tacticsIn("Would you like me to read them out loud?")).not.toContain("credentials");
    expect(tacticsIn("I can verify the last four digits of the card number.")).not.toContain("credentials");
  });
});

describe("sentences that once caused trouble", () => {
  const { ordinary, scams } = JSON.parse(fs.readFileSync("eval/everyday.json", "utf8")) as { ordinary: string[]; scams: string[] };
  const level = async (text: string) => {
    const detector = new Detector();
    await detector.hear(text);
    return detector.current;
  };

  it.each(ordinary)("does not tell someone to hang up on: %s", async (text) => {
    const state = await level(text);
    expect(state.level, state.seen.map((s) => s.tactic).join(", ")).toBeLessThan(3);
  });

  it.each(scams)("does tell someone to hang up on: %s", async (text) => {
    expect((await level(text)).level).toBe(3);
  });
});

describe("a semantic lookalike of a decisive tactic", () => {
  const lookalike = (similarity: number): Signal => ({ tactic: "safe_account", evidence: "", via: "semantic", similarity });

  it("warns but cannot say hang up alone", () => {
    expect(scoreSignals([lookalike(0.58)]).level).toBe(2);
    expect(scoreSignals([lookalike(0.58), signal("urgency")]).level).toBe(2);
  });

  it("can say hang up when very close to the examples", () => {
    expect(scoreSignals([lookalike(0.7)]).level).toBe(3);
  });

  it("gets a general warning, not the line that says hang up", () => {
    const seen = [lookalike(0.58)];
    expect(new Coach().afterCaller(seen, { seen, ...scoreSignals(seen) }, 0)?.line).toBe("warn_generic");
  });

  it("is replaced when the caller goes on to ask outright", async () => {
    const safeAccount = new Set(TACTICS.find((t) => t.id === "safe_account")!.exemplars);
    const embed = async (texts: string[]) => texts.map((t) => (safeAccount.has(t) ? [1, 0] : t === "lookalike" ? [0.55, 0] : [0, 0]));
    const detector = new Detector(embed);
    await detector.prepare();
    await detector.hear("lookalike");
    expect(detector.current.level).toBe(2);
    await detector.hear("You need to transfer your savings to a safe account.");
    expect(detector.current.level).toBe(3);
    expect(detector.current.score).toBe(5);
    expect(detector.current.seen).toHaveLength(1);
  });

  it("keeps what the patterns found if the embedding model fails", async () => {
    let failing = false;
    const detector = new Detector(async (texts) => {
      if (failing) throw new Error("model stopped");
      return texts.map(() => [1, 0]);
    });
    await detector.prepare();
    failing = true;
    await detector.hear("Please read that code out to me.");
    expect(detector.current.level).toBe(3);
  });
});

describe("joining chunks of speech", () => {
  it("doesn't judge a finished sentence twice", () => {
    expect(unfinishedTail("You can pay by card or bank transfer.")).toBe("");
  });

  it("keeps the unfinished end of a chunk, and only that", () => {
    expect(unfinishedTail("That's all. Please read me the")).toBe("Please read me the");
  });

  it("carries protective wording into the rest of its sentence", async () => {
    const detector = new Detector();
    await detector.hear(stitch(unfinishedTail("We will never ask you to"), "read out a code."));
    expect(detector.current.level).toBeLessThan(3);
  });

  it("doesn't let protective wording excuse the next request", async () => {
    const detector = new Detector();
    await detector.hear(stitch(unfinishedTail("We would never ask for your password"), "Read me the code we just sent you."));
    expect(detector.current.level).toBe(3);
  });
});

describe("scoring a call", () => {
  it("stays silent on one mild tactic", () => {
    expect(scoreSignals([signal("urgency")]).level).toBe(1);
  });

  it("speaks when mild tactics add up", () => {
    expect(scoreSignals([signal("urgency"), signal("too_good")]).level).toBe(2);
  });

  it("goes straight to hang up on a decisive tactic", () => {
    expect(scoreSignals([signal("credentials")]).level).toBe(3);
  });

  it("cannot be talked back down", async () => {
    const detector = new Detector();
    await detector.hear("Please read that code out to me.");
    await detector.hear("This is not a scam, you can trust me, and we will never ask for your PIN.");
    expect(detector.current.level).toBe(3);
  });
});

describe("what the person says", () => {
  it("recognises numbers being read out", () => {
    expect(isDisclosure("It's four seven two nine")).toBe(true);
    expect(isDisclosure("4729")).toBe(true);
    expect(isDisclosure("My PIN is")).toBe(true);
    expect(isDisclosure("I have one dog and two cats")).toBe(false);
  });

  it("recognises a code read out in groups", () => {
    expect(isDisclosure("472")).toBe(true);
    expect(isDisclosure("Four seven two.")).toBe(true);
    expect(isDisclosure("Double seven two nine")).toBe(true);
  });

  it("does not mistake everyday numbers or panic for a read-out", () => {
    for (const text of ["I was born in 1962.", "It was 1600 pounds", "We've got two dogs, one cat, three kids and four grandchildren", "Oh no, oh dear, oh my god, oh", "The code is on the fridge", "My PIN is private and I'm not giving it to you"]) {
      expect(isDisclosure(text), text).toBe(false);
    }
  });

  it("classifies replies", () => {
    expect(classifyUser("Coach, is this real?")).toBe("ask_is_real");
    expect(classifyUser("Hey coach, what should I say?")).toBe("ask_what_to_say");
    expect(classifyUser("Coach, hang up.")).toBe("hang_up");
    expect(classifyUser("I'll call back on the number on my card.")).toBe("resist");
    expect(classifyUser("Okay, what do you need me to do?")).toBe("comply");
    expect(classifyUser("Okay, it's three eight one nine")).toBe("disclosure");
  });

  it("knows someone leaving from someone staying", () => {
    for (const text of ["Hang up.", "Okay, I'm going to hang up now", "Right, I'm hanging up on you now", "Okay, bye", "Goodbye."]) expect(classifyUser(text), text).toBe("hang_up");
    for (const text of ["Don't hang up", "Don't hang up, I'm getting a pen", "I won't hang up on you", "Did you hang up?", "I'll just hang up my coat", "Say bye to your dad for me"]) expect(classifyUser(text), text).not.toBe("hang_up");
    expect(classifyUser("Coach, should I hang up?")).toBe("ask_what_to_say");
  });

  it("treats a plain refusal as a refusal", () => {
    for (const text of ["No.", "No thanks.", "I can't do that.", "That doesn't sound right.", "I'm not telling you that."]) expect(classifyUser(text), text).toBe("resist");
    expect(classifyUser("Oh no. Okay, what's happened?")).toBe("comply");
    expect(classifyUser("No problem, go on.")).not.toBe("resist");
  });

  it("hears the coach being addressed in everyday ways", () => {
    for (const text of ["Hey, coach, what should I say?", "Okay, coach, is this real?", "Is this real, coach?", "Coach"]) expect(isCommandToCoach(text), text).toBe(true);
    for (const text of ["My coach said to rest my knee", "The couch is new", "Couch is new, we got it last week"]) expect(isCommandToCoach(text), text).toBe(false);
  });

  it("does not take a caller's pressure for a command to the coach", () => {
    for (const text of ["If you hang up now, your money will be gone by tonight.", "Don't hang up.", "Stay on the line, do not end this call.", "Goodbye."]) expect(isCommandToCoach(text), text).toBe(false);
    expect(isCommandToCoach("Hang up.")).toBe(true);
    expect(isCommandToCoach("Coach, hang up.")).toBe(true);
  });
});

describe("coach behaviour", () => {
  const state = (...tactics: Signal["tactic"][]) => {
    const seen = tactics.map(signal);
    return { seen, ...scoreSignals(seen) };
  };

  it("says nothing until the call gives it a reason", () => {
    const coach = new Coach();
    expect(coach.afterCaller([signal("urgency")], state("urgency"), 0)).toBeNull();
  });

  it("names the most serious new tactic", () => {
    const coach = new Coach();
    const line = coach.afterCaller([signal("urgency"), signal("secrecy")], state("urgency", "secrecy"), 0);
    expect(line?.line).toBe("secrecy");
  });

  it("lets a decisive tactic through a recent warning", () => {
    const coach = new Coach();
    coach.afterCaller([signal("secrecy")], state("secrecy"), 0);
    const line = coach.afterCaller([signal("credentials")], state("secrecy", "credentials"), 500);
    expect(line).toMatchObject({ line: "credentials", urgent: true });
  });

  it("leaves a gap between ordinary warnings", () => {
    const coach = new Coach();
    coach.afterCaller([signal("secrecy")], state("secrecy"), 0);
    expect(coach.afterCaller([signal("threat")], state("secrecy", "threat"), 2000)).toBeNull();
  });

  it("does not interrupt someone reading a number on an ordinary call", () => {
    const coach = new Coach();
    expect(coach.afterUser("disclosure", state(), 0)).toBeNull();
    expect(coach.afterUser("disclosure", state("urgency"), 0)?.line).toBe("disclosure_stop");
  });

  it("does not say nothing worried it after a threat", () => {
    const coach = new Coach();
    expect(coach.afterUser("ask_is_real", state(), 0)?.line).toBe("answer_nothing_yet");
    expect(coach.afterUser("ask_is_real", state("threat"), 0)?.line).toBe("answer_one_thing");
    expect(coach.afterUser("ask_is_real", state("threat", "secrecy"), 0)?.line).toBe("answer_worried");
  });

  it("says hang up the moment the score gets there, even straight after another warning", () => {
    const coach = new Coach();
    coach.afterCaller([signal("secrecy")], state("secrecy"), 0);
    expect(coach.afterCaller([signal("identity_number")], state("secrecy", "identity_number"), 3000)?.line).toBe("get_out");
  });
});

describe("the fixed script", () => {
  it("has a line for every tactic", () => {
    for (const tactic of TACTICS) expect(LINES[tactic.id]).toBeDefined();
  });

  it("never calls a call safe or praises the person", () => {
    for (const [id, line] of Object.entries(LINES)) {
      expect(line.text, id).not.toMatch(/\b(well done|you('re| are) safe|nothing .* worried|this call is (safe|fine))\b/i);
    }
  });

  it("only links to steps that exist", () => {
    for (const scenario of SCENARIOS) {
      const ids = new Set(scenario.steps.map((s) => s.id));
      for (const step of scenario.steps) {
        for (const next of Object.values(step.next)) expect(ids.has(next)).toBe(true);
        if (!step.ends) expect(step.next.silence).toBeDefined();
      }
    }
  });
});

describe("segmenting speech", () => {
  const SR = 16000;
  const tone = (ms: number, amp: number) => Float32Array.from({ length: (SR * ms) / 1000 }, (_, i) => amp * Math.sin(i / 8));
  /** Speech isn't steady: it dips between syllables. A steady tone would count as background noise. */
  const speech = (ms: number, amp = 0.2) =>
    Float32Array.from({ length: (SR * ms) / 1000 }, (_, i) => amp * (i % 4800 < 800 ? 0.15 : 1) * Math.sin(i / 8));
  const noisy = (samples: Float32Array, amp: number) => samples.map((s, i) => s + amp * Math.sin(i / 3));

  const run = (...parts: Float32Array[]) => {
    const chunks: Chunk[] = [];
    const segmenter = new Segmenter({ sampleRate: SR }, (c) => chunks.push(c));
    for (const part of parts) segmenter.push(part);
    return chunks;
  };

  it("emits one chunk for speech followed by a pause", () => {
    expect(run(tone(300, 0), tone(1000, 0.2), tone(700, 0))).toHaveLength(1);
  });

  it("ignores a short click", () => {
    expect(run(tone(300, 0), tone(60, 0.5), tone(700, 0))).toHaveLength(0);
  });

  it("cuts long speech so it can be acted on while still going", () => {
    expect(run(tone(300, 0), speech(9000)).length).toBeGreaterThanOrEqual(2);
  });

  it("makes a forced cut at a quiet moment, not through a word", () => {
    const chunks = run(tone(300, 0), speech(3000), tone(60, 0.001), speech(3000));
    const firstSeconds = chunks[0].samples.length / SR;
    // Starts with 180ms of pre-roll, then 3s of speech, then the dip.
    expect(firstSeconds).toBeGreaterThan(3.1);
    expect(firstSeconds).toBeLessThan(3.4);
  });

  it("does not trigger on steady quiet noise", () => {
    expect(run(tone(3000, 0.002))).toHaveLength(0);
  });

  it("still finds pauses on a noisy line", () => {
    // Noise this loud starts out above the speech threshold. The floor has to learn it anyway.
    const line = [tone(2500, 0), speech(1500), tone(1000, 0), speech(1500), tone(1000, 0)].map((part) => noisy(part, 0.03));
    expect(run(...line).length).toBeGreaterThanOrEqual(2);
  });
});

describe("found by the final review", () => {
  const levelOf = async (...sentences: string[]) => {
    const detector = new Detector(null);
    await detector.prepare();
    for (const sentence of sentences) await detector.hear(sentence);
    return detector.current;
  };

  it.each([
    "You don't have to pay anything, read me the code.",
    "You don't need to worry, just read me the code.",
    "Please don't tell anyone about this call, I need you to read me the code we just sent you.",
    "We won't charge you, and give me your PIN.",
  ])("a comma or \"and\" can't hide an ask behind protective wording: %s", async (text) => {
    expect((await levelOf(text)).level).toBe(3);
  });

  it.each([
    "We will never ask you to read out a code.",
    "Don't tell anyone your PIN.",
    "Your bank will never ask you to give your password, share a code or move money.",
  ])("protective wording still protects: %s", async (text) => {
    expect((await levelOf(text)).level).toBeLessThan(3);
  });

  it.each(["Can I have your PIN please?", "Could I take your card number?", "And your PIN is?"])("the commonest ways to ask for a secret count: %s", (text) => {
    expect(tacticsIn(text)).toContain("credentials");
  });

  it("treats a social security number as an identity number, not a security number", () => {
    const tactics = tacticsIn("Can you confirm your social security number please?");
    expect(tactics).toContain("identity_number");
    expect(tactics).not.toContain("credentials");
  });

  it("can't say hang up on similarity alone, however many matches add up", () => {
    const lookalike = (tactic: Signal["tactic"]): Signal => ({ tactic, evidence: "", via: "semantic", similarity: 0.6 });
    expect(scoreSignals([lookalike("safe_account"), lookalike("untraceable_payment")]).level).toBe(2);
  });

  it("says possibly when only similarity saw it", () => {
    expect(describeSignal({ tactic: "bank_details", evidence: "", via: "semantic", similarity: 0.55 })).toMatch(/^Possibly:/);
    expect(describeSignal(signal("bank_details"))).not.toMatch(/^Possibly:/);
  });

  it("doesn't mistake routine deposits, or miss hyphens and couriers", () => {
    expect(tacticsIn("We'll transfer your tenancy deposit to a protected account.")).not.toContain("safe_account");
    expect(tacticsIn("You need to buy some gift-cards and read me the codes.")).toContain("untraceable_payment");
    expect(tacticsIn("Put your card in an envelope and a courier will come and collect it.")).toContain("untraceable_payment");
  });

  it("treats only a short sentence as a command to the coach", () => {
    expect(isCommandToCoach("Coach, hang up")).toBe(true);
    expect(isCommandToCoach("Coach, you need to go to the shop and buy some gift cards today")).toBe(false);
  });

  it("knows a code from an amount or a time", () => {
    expect(isDisclosure("Hang on, it's 4729")).toBe(true);
    expect(isDisclosure("It says 4729.")).toBe(true);
    expect(isDisclosure("It's £472.")).toBe(false);
    expect(isDisclosure("Ten thirty.")).toBe(false);
    expect(isDisclosure("My PIN is none of your business.")).toBe(false);
  });

  it("recognises a code read a digit at a time", () => {
    expect(isDigitsOnly("Four.")).toBe(true);
    expect(isDigitsOnly("Four seven")).toBe(true);
    expect(isDigitsOnly("Four dogs")).toBe(false);
    expect(isDigitsOnly("Hello")).toBe(false);
  });

  it("keeps protective wording across a pause, even when the speech model adds a full stop", () => {
    const tail = unfinishedTail("We will never ask you to.");
    expect(tail).not.toBe("");
    expect(stitch(tail, "read out a code.")).not.toContain("to. read");
  });

  it("can still say hang up after backing someone up", () => {
    const coach = new Coach();
    coach.afterPushback(0);
    const seen = [signal("secrecy"), signal("advance_fee")];
    const line = coach.afterCaller(seen, { seen, ...scoreSignals(seen) }, 1000);
    expect(line?.line).toBe("get_out");
    expect(line?.urgent).toBe(false); // So it waits for the pushback line to finish, and doesn't cut it off.
  });

  it("doesn't let a misheard coach cut off an urgent line", () => {
    expect(new Coach().afterUser("ask_unclear", { seen: [], score: 0, level: 0 }, 0)?.urgent).toBe(false);
  });
});
