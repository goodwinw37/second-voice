// Scripted practice calls. The caller's lines are pre-recorded, but they still go
// through real speech recognition, so the coach reacts to what it hears rather
// than reading this file.
//
// Each step plays a line, then listens. What the person says picks the next step,
// so people can stay in the conversation, push back or hang up.

export interface Step {
  id: string;
  text: string;
  /** What the scripted "you" says, in order, when playing the call hands-free. */
  demoReplies?: string[];
  next: {
    resist?: string;
    comply?: string;
    silence?: string;
  };
  /** Marks this step as the caller pressing on after the person tried to leave. */
  pushback?: boolean;
  /** The caller gives up and ends the call after this line. */
  ends?: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  subtitle: string;
  callerName: string;
  /** Shown to the person so they know what the coach is meant to do. */
  expectation: string;
  genuine: boolean;
  steps: Step[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "bank",
    title: "“Your bank's fraud team”",
    subtitle: "A safe-account scam",
    callerName: "Unknown number",
    expectation: "The coach should warn you, then tell you to hang up.",
    genuine: false,
    steps: [
      {
        id: "open",
        text: "Hello, this is Daniel from the fraud team at your bank. We've seen some suspicious payments on your account this morning, and I need your help to stop them.",
        demoReplies: ["Oh no. Okay, what's happened?"],
        next: { comply: "secret", resist: "secret", silence: "secret" },
      },
      {
        id: "secret",
        text: "We think someone at your local branch is involved. So it's very important that you don't tell anyone about this call, not even the staff at your bank.",
        demoReplies: ["I'll call back on a number I trust."],
        next: { comply: "move", resist: "press", silence: "move" },
      },
      {
        id: "press",
        pushback: true,
        text: "If you hang up now, your money will be gone by tonight. I can't protect you unless you stay on the line. This has to happen right now.",
        demoReplies: ["Okay. What do you need me to do?"],
        next: { comply: "move", resist: "giveup", silence: "move" },
      },
      {
        id: "move",
        text: "Thank you. We've set up a safe account in your name. You need to transfer your savings there straight away, before the criminals can reach them.",
        demoReplies: ["Okay. How do I do that?"],
        next: { comply: "code", resist: "giveup", silence: "code" },
      },
      {
        id: "code",
        text: "I've just sent you a text message with a six digit code. Please read that code out to me so I can verify the transfer.",
        demoReplies: ["Okay, it's four seven two nine", "Coach, is this real?", "Coach, hang up."],
        next: { comply: "giveup", resist: "giveup", silence: "giveup" },
      },
      {
        id: "giveup",
        text: "Fine. It's your money. Don't say we didn't warn you.",
        ends: true,
        next: {},
      },
    ],
  },
  {
    id: "family",
    title: "“Mum, it's me”",
    subtitle: "A family emergency, perhaps with a cloned voice",
    callerName: "Unknown number",
    expectation: "The coach listens to what's being asked, not to the voice, so a good clone doesn't fool it on sound alone.",
    genuine: false,
    steps: [
      {
        id: "open",
        text: "Mum, it's me. I've dropped my phone and smashed it, so I'm on my friend's phone. This is my new number for now.",
        demoReplies: ["Oh no, are you alright?"],
        next: { comply: "money", resist: "money", silence: "money" },
      },
      {
        id: "money",
        text: "I'm okay, but I can't get into my banking app, and my rent is due today. Can you send sixteen hundred pounds to my landlord for me? I'll pay you back on Friday.",
        demoReplies: ["I'll call back on a number I trust."],
        next: { comply: "secret", resist: "press", silence: "secret" },
      },
      {
        id: "press",
        pushback: true,
        text: "Mum, I can't take a call on this phone, it's my friend's. Please, I really need this right now, or I'll be kicked out.",
        demoReplies: ["Okay. Okay, what are the details?"],
        next: { comply: "secret", resist: "giveup", silence: "secret" },
      },
      {
        id: "secret",
        text: "Please don't tell Dad, he'll go mad. And if the bank asks what it's for, just say it's for a family member, or they might block it.",
        demoReplies: ["Hang up."],
        next: { comply: "giveup", resist: "giveup", silence: "giveup" },
      },
      {
        id: "giveup",
        text: "Okay. Forget it then. Thanks a lot, Mum.",
        ends: true,
        next: {},
      },
    ],
  },
  {
    id: "genuine",
    title: "A genuine bank call",
    subtitle: "The control: the coach should stay quiet",
    callerName: "Your bank",
    expectation: "The coach should say nothing during the call. A coach that cries wolf gets switched off.",
    genuine: true,
    steps: [
      {
        id: "open",
        text: "Hello, this is Priya from the fraud team at your bank. I'm calling to check a payment on your card yesterday. We will never ask for your PIN or your full password, and I won't ask you to move any money.",
        demoReplies: ["Okay, go on."],
        next: { comply: "check", resist: "check", silence: "check" },
      },
      {
        id: "check",
        text: "Did you spend forty two pounds at a shop in Leeds yesterday afternoon?",
        demoReplies: ["Yes, that was me."],
        next: { comply: "close", resist: "close", silence: "close" },
      },
      {
        id: "close",
        text: "Thanks, that's all I needed. If you'd like to check this was really us, please hang up and call the number on the back of your card, whenever suits you. Have a lovely day.",
        ends: true,
        next: {},
      },
    ],
  },
];

export function clipId(scenarioId: string, stepId: string, kind: string): string {
  return `${scenarioId}-${stepId}-${kind}`;
}
