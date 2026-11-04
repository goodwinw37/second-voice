// Runs real calls in real Chrome and checks what the coach did.
//
// Nothing here is mocked. Pre-recorded audio plays through the app's audio graph,
// goes through speech recognition in the browser, and the coach reacts to the
// result. A fake microphone device feeds a WAV file for the microphone tests.
//
//   npm run dev       (in another terminal)
//   npm run e2e       or: npm run e2e -- bank    to run one part
//
// Parts: bank, family, genuine, hangup, listen, roomwords, mic, bargein, offline.
// The listen part makes its own unscripted audio with the macOS "say" command, and is skipped elsewhere.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const URL_BASE = process.env.E2E_URL ?? "http://localhost:5173/";
const outDir = process.env.E2E_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), "second-voice-e2e-"));
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
};

async function launch(extraArgs = []) {
  // Playwright mutes headless Chrome by default, and a muted tab once hid a real microphone bug. So the tab stays
  // unmuted here, with its sound sent nowhere, because nobody wants this playing out of their speakers for 8 minutes.
  return chromium.launch({ channel: "chrome", headless: true, ignoreDefaultArgs: ["--mute-audio"], args: ["--autoplay-policy=no-user-gesture-required", "--disable-audio-output", ...extraArgs] });
}

/** Opens the app and waits for the models. Returns a list of external requests made after that point. */
async function openApp(browser, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.secondVoice?.isReady(), null, { timeout: 300000 });
  const external = [];
  page.on("request", (r) => { if (!r.url().startsWith(URL_BASE) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) external.push(r.url()); });
  return { page, context, errors, external };
}

const events = (page) => page.evaluate(() => window.secondVoice.events);
const waitForEnd = (page, timeout = 300000) =>
  page.waitForFunction(() => window.secondVoice.events.some((e) => e.type === "ended"), null, { timeout });

function printTimeline(log) {
  for (const e of log) {
    const t = `${(e.atMs / 1000).toFixed(1).padStart(6)}s`;
    if (e.type === "transcript") console.log(`${t}  ${e.who.padEnd(6)} (${e.asrMs}ms) ${e.text}`);
    if (e.type === "signal") console.log(`${t}  SIGNAL ${e.signal.tactic} via ${e.signal.via}${e.signal.similarity ? ` ${e.signal.similarity.toFixed(2)}` : ""}`);
    if (e.type === "level") console.log(`${t}  LEVEL  ${e.level} (score ${e.score})`);
    if (e.type === "intent") console.log(`${t}  INTENT ${e.intent}`);
    if (e.type === "coach") console.log(`${t}  COACH  [${e.line}]${e.latencyMs !== null ? ` ${e.latencyMs}ms` : ""} ${e.text}`);
  }
}

async function runScenario(browser, id, verify) {
  console.log(`\n=== Hands-free: ${id}`);
  const { page, context, errors, external } = await openApp(browser);
  await page.click(`[data-scenario="${id}"]`);
  await page.waitForTimeout(12000);
  await page.screenshot({ path: path.join(outDir, `${id}-call.png`), fullPage: true });
  if (id !== "genuine") {
    await page.waitForFunction(() => window.secondVoice.events.some((e) => e.type === "coach" && e.urgent), null, { timeout: 120000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, `${id}-warning.png`), fullPage: true });
  }
  await waitForEnd(page);
  const log = await events(page);
  printTimeline(log);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, `${id}-summary.png`), fullPage: true });
  verify(log);
  noLineCutOff(log);
  check(external.length === 0, `no external requests during the call (${external.length})`);
  check(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await context.close();
  return log;
}

const coachLines = (log) => log.filter((e) => e.type === "coach").map((e) => e.line);
/** A warning must get time to be heard before the next one starts. */
function noLineCutOff(log) {
  const coach = log.filter((e) => e.type === "coach");
  const gaps = coach.slice(1).map((e, i) => e.atMs - coach[i].atMs);
  check(gaps.every((g) => g >= 2500), `no coach line was cut off by another (shortest gap ${gaps.length ? Math.min(...gaps) : "n/a"}ms)`);
}
const maxLevel = (log) => log.find((e) => e.type === "ended").level;
const before = (log, a, b) => log.findIndex(a) < log.findIndex(b);

// A fake microphone needs a path with no spaces, so its audio is kept in a folder of its own.
const micFolder = fs.mkdtempSync(path.join(os.tmpdir(), "second-voice-mic-"));

function fakeMicArgs(file) {
  return ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${file}%noloop`];
}

/** One of the app's own recorded clips as a microphone file, after some silence if asked. The clips are 16-bit WAVs with a 44-byte header. */
function clipAsMic(id, silenceSeconds = 0) {
  const clip = fs.readFileSync(new URL(`../public/audio/${id}.wav`, import.meta.url));
  const byteRate = clip.readUInt32LE(28);
  const silence = Buffer.alloc(Math.round(byteRate * silenceSeconds) & ~1);
  const out = Buffer.concat([clip.subarray(0, 44), silence, clip.subarray(44)]);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(out.length - 44, 40);
  const file = path.join(micFolder, `${id}-${silenceSeconds}.wav`);
  fs.writeFileSync(file, out);
  return file;
}

const UNSCRIPTED =
  "Hello, this is the fraud team at your bank. Please do not tell anyone about this call, not even your family. You need to go to the shop and buy five hundred pounds of gift cards, and then read me the codes on the back.";

/** Speech the app has never heard, for the listen test. Returns null if there's no "say" command to make it. */
function unscriptedAudio() {
  if (process.env.E2E_LISTEN_WAV) return process.env.E2E_LISTEN_WAV;
  if (process.platform !== "darwin") return null;
  const file = path.join(micFolder, "unscripted.wav");
  execFileSync("say", ["-v", "Daniel", "--file-format=WAVE", "--data-format=LEI16@16000", "-o", file, UNSCRIPTED]);
  return file;
}

const isOpen = (page) =>
  Promise.race([page.evaluate(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);

const only = process.argv[2];
const browser = await launch();
const latencies = [];

if (!only || only === "bank") {
  const log = await runScenario(browser, "bank", (log) => {
    const lines = coachLines(log);
    check(maxLevel(log) === 3, "reached the highest risk level");
    check(lines.includes("secrecy"), "warned about secrecy");
    check(lines.includes("pushback"), "backed the person up when the caller pressed on");
    check(lines.includes("safe_account"), "called out the safe account");
    check(lines.includes("credentials"), "stopped the request for a code");
    check(lines.includes("disclosure_stop"), "interrupted when numbers were read out");
    check(lines.includes("answer_worried"), "answered 'is this real?' honestly");
    check(lines.at(-1) === "ended_safely", "ended with what to do next");
    check(before(log, (e) => e.type === "coach" && e.line === "secrecy", (e) => e.type === "coach" && e.line === "safe_account"), "warned before the money was asked for");
  });
  latencies.push(...log.filter((e) => e.type === "ended").flatMap((e) => e.latencies));
}

if (!only || only === "family") {
  const log = await runScenario(browser, "family", (log) => {
    const lines = coachLines(log);
    check(maxLevel(log) === 3, "reached the highest risk level");
    check(lines.includes("money_request") || lines.includes("family_emergency"), "warned at the request for money");
    check(lines.includes("coached_lie"), "called out being told what to tell the bank");
    check(lines.at(-1) === "ended_family", "ended by telling them to ring their relative");
  });
  latencies.push(...log.filter((e) => e.type === "ended").flatMap((e) => e.latencies));
}

if (!only || only === "genuine") {
  await runScenario(browser, "genuine", (log) => {
    const lines = coachLines(log);
    check(maxLevel(log) < 2, `stayed below warning level (reached ${maxLevel(log)})`);
    check(lines.length === 1 && lines[0] === "ended_clean", `the coach stayed silent during the call (said: ${lines.join(", ")})`);
  });
}

if (!only || only === "hangup") {
  console.log("\n=== Hanging up at awkward moments");
  // The coach telling someone to hang up is when they're most likely to press this.
  {
    const { page, context, errors } = await openApp(browser);
    await page.click('[data-scenario="bank"]');
    await page.waitForFunction(() => window.secondVoice.events.some((e) => e.type === "coach"), null, { timeout: 120000 });
    await page.waitForTimeout(1000);
    await page.click(".hang-up", { timeout: 5000 });
    await waitForEnd(page, 30000);
    check(await isOpen(page), "hanging up while the coach is talking doesn't freeze the page");
    check(await page.locator("text=Try another call").isVisible(), "and reaches the summary");
    check(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
    await context.close();
  }
  // Just after the caller stops, with their last words still being recognised.
  {
    const { page, context, errors } = await openApp(browser);
    await page.click('[data-scenario="genuine"]');
    await page.waitForFunction(() => window.secondVoice.events.filter((e) => e.type === "status" && e.text === "Your turn").length >= 1, null, { timeout: 60000 });
    await page.click(".hang-up", { timeout: 5000 });
    await waitForEnd(page, 30000);
    check(await isOpen(page), "hanging up just after the caller stops works too");
    check(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
    await context.close();
  }
  // Before anything has loaded.
  {
    const { page, context, errors } = await openApp(browser);
    await page.evaluate(() => {
      document.querySelector('[data-scenario="bank"]').click();
      setTimeout(() => document.querySelector(".hang-up").click(), 50);
    });
    await waitForEnd(page, 30000);
    check(await page.locator("text=Try another call").isVisible(), "hanging up while connecting reaches the summary");
    check(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
    await context.close();
  }
}
await browser.close();

if (!only || only === "roomwords") {
  console.log("\n=== Listen mode: the caller saying 'if you hang up now'");
  const micBrowser = await launch(fakeMicArgs(clipAsMic("bank-press-caller")));
  const { page, context, errors } = await openApp(micBrowser);
  await page.click("[data-listen]");
  await page.waitForFunction(() => window.secondVoice.events.filter((e) => e.type === "signal").length >= 2, null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  const log = await events(page);
  printTimeline(log);
  check(!log.some((e) => e.type === "intent" && e.intent === "hang_up"), "the caller's words weren't taken as the person hanging up");
  check(!log.some((e) => e.type === "ended"), "and it kept listening");
  check(log.some((e) => e.type === "signal" && e.signal.tactic === "threat"), "and it counted the threat");
  await page.click(".hang-up");
  await waitForEnd(page, 30000);
  const final = await events(page);
  check(coachLines(final).at(-1) !== "ended_clean", "pressing stop doesn't then say the call was fine");
  check(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  await context.close();
  await micBrowser.close();
}

if (!only || only === "listen") {
  console.log("\n=== Listening to unscripted audio through the microphone path");
  const wav = unscriptedAudio();
  if (!wav) {
    console.log("  SKIP  set E2E_LISTEN_WAV to a WAV of a scam script");
  } else {
    const micBrowser = await launch(fakeMicArgs(wav));
    const { page, context, errors, external } = await openApp(micBrowser);
    await page.click("[data-listen]");
    await page.waitForFunction(() => window.secondVoice.events.some((e) => e.type === "coach"), null, { timeout: 90000 });
    await page.waitForTimeout(15000);
    const log = await events(page);
    printTimeline(log);
    await page.screenshot({ path: path.join(outDir, "listen.png"), fullPage: true });
    check(log.some((e) => e.type === "transcript"), "transcribed speech from the microphone");
    check(log.some((e) => e.type === "coach"), "the coach reacted to unscripted audio");
    check(log.some((e) => e.type === "signal" && e.signal.tactic === "untraceable_payment"), "kept listening while the coach spoke, and caught the gift cards");
    check(external.length === 0, `no external requests while listening (${external.length})`);
    check(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
    await context.close();
    await micBrowser.close();
  }
}

if (!only || only === "mic") {
  console.log("\n=== Taking the call by microphone");
  {
    // This fake microphone loops, so the reply is there whenever the app starts listening.
    const wav = process.env.E2E_MIC_WAV ?? clipAsMic("bank-secret-you0");
    const micBrowser = await launch(fakeMicArgs(wav).map((a) => a.replace("%noloop", "")));
    const { page, context, errors } = await openApp(micBrowser);
    await page.click(".mode-option:nth-child(2)");
    await page.click('[data-scenario="bank"]');
    await waitForEnd(page);
    const log = await events(page);
    printTimeline(log);
    check(log.some((e) => e.type === "transcript" && e.who === "you"), "heard the person through the microphone");
    check(log.some((e) => e.type === "intent" && e.intent === "resist"), "understood them pushing back");
    check(coachLines(log).includes("pushback"), "backed them up when the caller pressed on");
    check(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
    await context.close();
    await micBrowser.close();
  }
}

if (!only || only === "bargein") {
  console.log("\n=== Saying 'hang up' over the top of the caller");
  {
    const wav = process.env.E2E_BARGEIN_WAV ?? clipAsMic("family-secret-you0", 4);
    const micBrowser = await launch(fakeMicArgs(wav));
    const { page, context, errors } = await openApp(micBrowser);
    await page.click(".mode-option:nth-child(2)");
    await page.click('[data-scenario="bank"]');
    await waitForEnd(page, 60000);
    const log = await events(page);
    printTimeline(log);
    const hangUp = log.find((e) => e.type === "intent" && e.intent === "hang_up");
    const callerTurns = log.filter((e) => e.type === "transcript" && e.who === "caller").length;
    check(!!hangUp, "heard 'hang up' while the caller was talking");
    check(callerTurns <= 3, `the call stopped straight away (${callerTurns} caller phrases)`);
    check(errors.length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
    await context.close();
    await micBrowser.close();
  }
}

if (!only || only === "offline") {
  console.log("\n=== Working with no internet once the models are cached");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "second-voice-profile-"));
  const context = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await context.newPage();
  const started = Date.now();
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.secondVoice?.isReady(), null, { timeout: 300000 });
  console.log(`  First load with an empty cache: ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const blocked = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(URL_BASE) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  const again = Date.now();
  await page.reload();
  await page.waitForFunction(() => window.secondVoice?.isReady(), null, { timeout: 60000 });
  console.log(`  Reload with the internet blocked: ${((Date.now() - again) / 1000).toFixed(1)}s, ${blocked.length} attempts blocked`);
  await page.click('[data-scenario="genuine"]');
  await page.waitForFunction(() => window.secondVoice.events.some((e) => e.type === "transcript" && e.who === "caller"), null, { timeout: 30000 });
  check(true, "models loaded and speech was recognised with the internet blocked");
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

if (latencies.length) {
  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(`\nUrgent line latency over ${sorted.length} lines: median ${sorted[Math.floor(sorted.length / 2)]}ms, min ${sorted[0]}ms, max ${sorted.at(-1)}ms`);
}
console.log(`\nScreenshots: ${outDir}`);
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
