// The interface: choose a call, follow it live, read the summary afterwards.
//
// Deliberately plain DOM. In the real product there would be no screen at all
// during a call. This one exists so that someone watching a demo can see what
// the coach heard, why it spoke, and how long that took.

import { SCENARIOS, type Scenario } from "../call/scenarios.ts";
import { SpeechClient } from "../speech/client.ts";
import { Session, type Mode, type SessionEvent } from "./session.ts";
import { describeSignal, type RiskLevel, type Signal } from "../detect/detector.ts";

const app = document.querySelector<HTMLElement>("#app")!;
const speech = new SpeechClient();

let modelsReady = false;
let handsFree = true;
let session: Session | null = null;

/** The two speech models together. */
const MODEL_BYTES = 108e6;

const LEVELS: Record<RiskLevel, { name: string; detail: string }> = {
  0: { name: "Listening quietly", detail: "Nothing to warn you about so far." },
  1: { name: "Paying attention", detail: "Something stood out. Not enough to interrupt you." },
  2: { name: "Warning you", detail: "Pressure tactics are adding up." },
  3: { name: "Get out", detail: "This has signs of a scam. Hang up and check another way." },
};

/** Exposed so the end-to-end test can read exactly what happened during a call. */
const eventLog: Array<SessionEvent & { atMs: number }> = [];
(window as unknown as { secondVoice: unknown }).secondVoice = {
  events: eventLog,
  isReady: () => modelsReady,
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---- Start screen -------------------------------------------------------------

function renderStart(): void {
  app.replaceChildren();
  window.scrollTo(0, 0);
  const page = element("div", "start");

  const header = element("header", "hero");
  header.append(
    element("p", "eyebrow", "Second Voice · a prototype for practice calls"),
    element("h1", undefined, "A voice in your ear when a phone call turns into a scam."),
    element(
      "p",
      "lede",
      "Scams work by rushing you and cutting you off from anyone who could help. You can't read a warning with a phone at your ear, so Second Voice tells you what's happening and what to say back, while it's happening.",
    ),
  );

  const status = element("div", "model-status");
  status.id = "model-status";
  updateModelStatus(status);

  const controls = element("div", "mode-switch");
  controls.setAttribute("role", "radiogroup");
  controls.setAttribute("aria-label", "How to play the practice call");
  for (const [value, title, detail] of [
    [true, "Watch it hands-free", "A scripted “you” answers. No microphone needed."],
    [false, "Take the call yourself", "Answer out loud. Try “Coach, is this real?” or “Coach, hang up”."],
  ] as const) {
    const option = element("button", `mode-option${handsFree === value ? " is-selected" : ""}`);
    option.type = "button";
    option.setAttribute("role", "radio");
    option.setAttribute("aria-checked", String(handsFree === value));
    option.append(element("strong", undefined, title), element("span", undefined, detail));
    option.addEventListener("click", () => {
      handsFree = value;
      renderStart();
    });
    controls.append(option);
  }

  const scenarios = element("section", "scenarios");
  scenarios.setAttribute("aria-label", "Practice calls");
  for (const scenario of SCENARIOS) {
    const card = element("button", `scenario${scenario.genuine ? " is-control" : ""}`);
    card.type = "button";
    card.disabled = !modelsReady;
    card.dataset.scenario = scenario.id;
    card.append(
      element("span", "scenario-tag", scenario.genuine ? "Control" : "Scam"),
      element("strong", undefined, scenario.title),
      element("span", "scenario-sub", scenario.subtitle),
      element("span", "scenario-expect", scenario.expectation),
    );
    card.addEventListener("click", () => beginCall(handsFree ? "demo" : "mic", scenario));
    scenarios.append(card);
  }

  const listen = element("section", "listen");
  const listenText = element("div");
  listenText.append(
    element("strong", undefined, "Or read your own script"),
    element("span", undefined, "Read a scam script aloud in your own words. The coach isn't following a script here. For practice only: don't use it on a real call. It can miss scams and raise false alarms, it can't end a phone call, and the other person wouldn't know it was listening."),
  );
  const listenButton = element("button", "secondary", "Start listening");
  listenButton.type = "button";
  listenButton.disabled = !modelsReady;
  listenButton.dataset.listen = "true";
  listenButton.addEventListener("click", () => beginCall("listen", null));
  listen.append(listenText, listenButton);

  const notes = element("ul", "notes");
  for (const note of [
    "Wear headphones: the caller is in your left ear and the coach in your right.",
    "Speech recognition runs on this device. Nothing you say is sent anywhere.",
    "This is a prototype. It catches some scams, misses others, and sometimes warns about genuine calls, so it isn't protection you can rely on yet.",
  ]) {
    notes.append(element("li", undefined, note));
  }

  page.append(header, status, controls, scenarios, listen, notes);
  app.append(page);
}

function updateModelStatus(node: HTMLElement, progress?: { loaded: number; total: number }): void {
  node.replaceChildren();
  if (modelsReady) {
    node.append(element("span", "dot is-ready"), element("span", undefined, "Ready. The speech models are running on this device."));
    return;
  }
  // Measured against the full download, because the total only grows as each file is found, and the bar would keep falling back.
  const total = Math.max(progress?.total ?? 0, MODEL_BYTES);
  const percent = progress ? Math.round((100 * progress.loaded) / total) : 0;
  const bar = element("progress");
  bar.max = 100;
  bar.value = percent;
  bar.setAttribute("aria-label", "Downloading speech models");
  node.append(
    element("span", undefined, "Getting the speech models ready. The first time, this downloads about 108 MB."),
    bar,
  );
}

// ---- Call screen --------------------------------------------------------------

interface CallView {
  statusText: HTMLElement;
  level: HTMLElement;
  levelName: HTMLElement;
  levelDetail: HTMLElement;
  coachText: HTMLElement;
  sayThis: HTMLElement;
  timeline: HTMLElement;
  chips: HTMLElement;
  latency: HTMLElement;
  hangUp: HTMLButtonElement;
}

function beginCall(mode: Mode, scenario: Scenario | null): void {
  eventLog.length = 0;
  const started = performance.now();
  const view = renderCall(mode, scenario);

  const thisCall = new Session(speech, mode, scenario, (event) => {
    eventLog.push({ ...event, atMs: Math.round(performance.now() - started) });
    handleEvent(view, event);
  });
  session = thisCall;

  thisCall.start().catch((error: Error) => {
    const message =
      error.name === "NotAllowedError"
        ? "The microphone is blocked. Allow it in your browser, or go back and use “Watch it hands-free”."
        : error.name === "NotFoundError"
          ? "No microphone found. Plug one in, or go back and use “Watch it hands-free”."
          : `Something went wrong: ${error.message}. Reload the page to try again.`;
    addCoachMessage(view, message);
    view.statusText.textContent = "Stopped";
    view.levelName.textContent = "Not listening";
    view.levelDetail.textContent = "The coach can't hear anything.";
    // The call never got going, so there's nothing to summarise. This button just needs to go back.
    void thisCall.abort();
    const back = element("button", "secondary", "Back");
    back.type = "button";
    back.addEventListener("click", renderStart);
    view.hangUp.replaceWith(back);
  });
}

function renderCall(mode: Mode, scenario: Scenario | null): CallView {
  app.replaceChildren();
  const page = element("div", "call");

  const bar = element("header", "call-bar");
  const who = element("div");
  who.append(
    element("strong", undefined, scenario ? scenario.callerName : "Listening to the room"),
    element("span", "call-status", "Connecting"),
  );
  const hangUp = element("button", "hang-up", mode === "listen" ? "Stop listening" : "Hang up");
  hangUp.type = "button";
  hangUp.addEventListener("click", () => void session?.hangUp(true));
  bar.append(who, hangUp);

  const coach = element("section", "coach level-0");
  coach.setAttribute("aria-live", "polite");
  const levelName = element("h2", "coach-level", LEVELS[0].name);
  const levelDetail = element("p", "coach-detail", LEVELS[0].detail);
  const coachText = element("p", "coach-text");
  const sayThis = element("p", "say-this");
  sayThis.hidden = true;
  const chips = element("div", "chips");
  coach.append(element("p", "ear", "Coach · right ear"), levelName, levelDetail, coachText, sayThis, chips);

  const transcript = element("section", "transcript");
  transcript.setAttribute("aria-label", "What the coach has heard");
  const heading = element("div", "transcript-head");
  const latency = element("span", "latency");
  heading.append(element("h3", undefined, "What the coach has heard"), latency);
  const timeline = element("ol", "timeline");
  transcript.append(heading, timeline);

  if (mode === "listen") {
    const hint = element("p", "script-hint");
    hint.textContent =
      "Practice only: don't use this on a real call. Try saying: “This is the fraud team at your bank. Please don't tell anyone about this call. I need you to read me the code we just sent you.” You can also ask “Coach, is this real?”";
    transcript.insertBefore(hint, timeline);
  }

  page.append(bar, coach, transcript);
  app.append(page);

  return {
    statusText: who.querySelector(".call-status")!,
    level: coach,
    levelName,
    levelDetail,
    coachText,
    sayThis,
    timeline,
    chips,
    latency,
    hangUp,
  };
}

function addLine(view: CallView, className: string, label: string, text: string): void {
  const item = element("li", `line ${className}`);
  item.append(element("span", "line-who", label), element("span", "line-text", text));
  view.timeline.append(item);
  view.timeline.scrollTop = view.timeline.scrollHeight;
}

function addCoachMessage(view: CallView, text: string): void {
  view.coachText.textContent = text;
  addLine(view, "is-coach", "Coach", text);
}

function handleEvent(view: CallView, event: SessionEvent): void {
  switch (event.type) {
    case "status":
      view.statusText.textContent = event.text === "Caller speaking" ? "Caller speaking · left ear" : event.text;
      if (event.text === "Call ended") {
        view.levelName.textContent = "Call ended";
        view.levelDetail.textContent = "Listen for what to do next, or skip to read it.";
        view.hangUp.textContent = "Skip";
      }
      break;
    case "transcript":
      // In listen mode one microphone hears everyone, so it can't say who spoke.
      addLine(view, event.who === "caller" ? "is-caller" : "is-you", event.who === "you" ? "You" : session?.isListening ? "Heard" : "Caller", event.text);
      break;
    case "signal": {
      // A possible match can later be confirmed, which updates its chip rather than adding another.
      const existing = [...view.chips.children].find((chip) => (chip as HTMLElement).dataset.tactic === event.signal.tactic);
      const chip = element("span", "chip", event.label);
      chip.dataset.tactic = event.signal.tactic;
      if (existing) existing.replaceWith(chip);
      else view.chips.append(chip);
      break;
    }
    case "level":
      view.level.className = `coach level-${event.level}`;
      view.levelName.textContent = LEVELS[event.level].name;
      view.levelDetail.textContent = LEVELS[event.level].detail;
      break;
    case "coach":
      addCoachMessage(view, event.text);
      // The phrase to say gets its own line below, so don't show it twice.
      if (event.sayThis) view.coachText.textContent = event.text.split(" Say: ")[0];
      view.sayThis.hidden = !event.sayThis;
      view.sayThis.textContent = event.sayThis ? `Say: “${event.sayThis}”` : "";
      if (event.latencyMs !== null) view.latency.textContent = `Spoke ${(event.latencyMs / 1000).toFixed(1)} s after that chunk of speech`;
      break;
    case "notice":
      view.statusText.textContent = "Not hearing properly";
      addCoachMessage(view, event.text);
      break;
    case "ended":
      renderSummary(event.level, event.signals, event.latencies, event.clean, event.heardProperly);
      break;
  }
}

// ---- After the call -----------------------------------------------------------

function renderSummary(level: RiskLevel, signals: Signal[], latencies: number[], clean: boolean, heardProperly: boolean): void {
  app.replaceChildren();
  window.scrollTo(0, 0);
  const page = element("div", "summary");
  const worried = level >= 2;
  const heading = worried
    ? "That call had the signs of a scam."
    : clean
      ? "The coach heard nothing to warn you about."
      : "The coach can't say that call was fine.";

  page.append(element("p", "eyebrow", "Call ended"), element("h1", undefined, heading));
  if (!heardProperly) page.append(element("p", "lede", "Something went wrong with listening during this call, so the coach may have missed things."));
  if (clean) page.append(element("p", "lede", "It can miss things. If you're unsure, check on a number you trust."));
  // With no warnings and nothing wrong with listening, this can only mean a read-out.
  if (!worried && !clean && heardProperly && signals.length === 0) {
    page.append(element("p", "lede", "You read out some numbers during this call, and the coach can't tell what they were."));
  }

  if (!clean) {
    const section = element("section", "next-steps");
    section.append(element("h2", undefined, "If this had been real"));
    const list = element("ol");
    const family = signals.some((s) => s.tactic === "family_emergency");
    for (const step of [
      "Use another phone if you can. If not, wait five minutes or ring a friend first, because some scammers stay on the line.",
      "Then, if you gave any details or money, or let them onto a device, call your bank straight away on 159 or the number on your card. It's not your fault.",
      family
        ? "Ring your relative on the number you already have. No answer? Try someone close to them."
        : "Even if you gave nothing away, you can call 159 to reach your bank, if you're in the UK and your bank is part of the service. If that doesn't work, use the number on your card.",
      "Report it to Report Fraud at reportfraud.police.uk or 0300 123 2040 (England, Wales and Northern Ireland). In Scotland, call Police Scotland on 101.",
      "If a crime is happening now or someone's in danger, call 999.",
      "If the call might have been genuine, ring them back on a number you found yourself. Checking costs you nothing.",
    ]) {
      const item = element("li");
      const [before, after] = step.split("reportfraud.police.uk");
      if (after === undefined) {
        item.textContent = step;
      } else {
        const link = element("a", undefined, "reportfraud.police.uk");
        link.href = "https://www.reportfraud.police.uk/";
        link.rel = "noreferrer";
        item.append(before, link, after);
      }
      list.append(item);
    }
    section.append(list);
    page.append(section);
  }

  if (signals.length > 0) {
    const section = element("section");
    section.append(element("h2", undefined, "What the coach heard"));
    const list = element("ul", "evidence");
    for (const signal of signals) {
      const item = element("li");
      item.append(
        element("strong", undefined, describeSignal(signal)),
        element("q", undefined, signal.evidence),
        element("span", "via", signal.via === "pattern" ? "matched a known phrase" : `reworded, ${Math.round((signal.similarity ?? 0) * 100)}% similar`),
      );
      list.append(item);
    }
    section.append(list);
    page.append(section);
  }

  const facts = element("p", "facts");
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  const fastest = seconds(Math.min(...latencies));
  const slowest = seconds(Math.max(...latencies));
  const speed = fastest === slowest ? `about ${fastest}` : `${fastest} to ${slowest}`;
  facts.textContent = latencies.length
    ? `Urgent warnings started ${speed} seconds after the chunk of speech that caused them. Nothing left this device.`
    : "Nothing left this device.";

  const again = element("button", "primary", "Try another call");
  again.type = "button";
  again.addEventListener("click", () => {
    session = null;
    renderStart();
  });

  page.append(facts, again);
  app.append(page);
}

// ---- Boot ---------------------------------------------------------------------

speech.onProgress = (progress) => {
  const node = document.querySelector<HTMLElement>("#model-status");
  if (node) updateModelStatus(node, progress);
};

renderStart();

speech
  .load()
  .then(() => {
    modelsReady = true;
    renderStart();
  })
  .catch(() => {
    const node = document.querySelector<HTMLElement>("#model-status");
    if (node) node.textContent = "Couldn't load the speech models. Check your connection and reload. Chrome works best.";
  });
