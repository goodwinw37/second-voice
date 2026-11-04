# Second Voice

A voice in your ear when a phone call turns into a scam.

Scams work by rushing you and cutting you off from anyone who could help. Second Voice listens to the call and, in your other ear, names what's happening and tells you what to say back. In the practice calls it also backs you up when the caller pushes (the script tells it when that's happening; it can't detect this in listen mode). If the call has already raised a flag and you start reading out a code, it interrupts you.

It's a working prototype for the Hiya Voice AI Challenge, in the Real-Time Assistance track. It runs in Chrome, on your device, with no API keys. It's a practice tool, because a browser can't get at real phone call audio and, as far as I could find, a normal phone app can't get at a call it isn't carrying ([details](#what-hasnt-been-tested-and-known-limits)).

The one-page write-up is [docs/writeup.pdf](docs/writeup.pdf). How AI was used, and what it got wrong, is in [ai.md](ai.md).

## Run it

You need [Node](https://nodejs.org) 22.18 or newer, Chrome and headphones.

Headphones are required. The caller is in your left ear and the coach in your right. Echo cancellation is also off, because it left the microphone deaf or garbled while audio was playing, so "Hang up" could go unheard. Without headphones the microphone hears the coach, and the coach's own "Hang up" can end a practice call.

```bash
npm ci
```

```bash
npm run dev
```

Then open http://localhost:5173. The first load downloads about 108 MB of speech models from Hugging Face. After that they come from the browser's cache, and the app works with no internet.

There are three things to try:

- **Watch it hands-free.** Pick a practice call and a scripted "you" answers. No microphone needed. Start with the bank call, then the genuine bank call, where the coach should stay quiet.
- **Take the call yourself.** Answer out loud. Try "I'll call back on a number I trust", "Coach, is this real?" or "Coach, hang up". Try reading out digits when asked for the code.
- **Read your own script.** Press Start listening and read a scam script aloud in your own words. Nothing here is scripted, so it's the real pipeline. It's for practice only, so don't use it on a real call.

## Why voice

Voice is the right interface at three moments, and the wrong one at a fourth.

1. **The phone is at your ear.** You can't see a screen.
2. **The caller sets the pace.** There's no time to read a warning and think about it. The coach waits for a pause if it can, and interrupts if it can't.
3. **It can hear you too.** You can ask "Coach, is this real?" without touching anything, and it can stop you reading out a code. A keyboard couldn't do either.
4. **After the call, a screen is better.** You need a list of what to do next and time to read it, so the summary is on screen.

Hiya and Google can already warn you that a call looks like a scam. As far as I could find, they don't tell you what to say next. This works on that next moment, and it listens to what's being asked rather than how the voice sounds, so it's meant to complement deepfake detection.

## How it works

```
caller audio ─► segmenter ─► Moonshine ─► detector ─► coach ─► a recorded line, right ear
  left ear                   speech to     patterns +   when to     or silence
                             text          MiniLM       speak
your microphone ─► segmenter ─► Moonshine ─► what you meant ─┘
```

The decisions that matter most:

- **Patterns and a small model classify. Nothing generates speech during a call.** All 35 coach lines were written in advance. A caller's speech is untrusted input, and a language model that listens to a scammer and talks to their victim can be manipulated by what the scammer says. Being fixed also means the lines can be recorded, so nothing has to be generated before the coach speaks.
- **It listens to behaviour, not voice quality.** It looks for 22 tactics, such as secrecy, safe accounts and requests for codes. A good voice clone doesn't change what's being asked for.
- **It stays quiet unless there's a reason.** Mild signs only show on screen, and it speaks at a score of 3. It says hang up on something decisive, or when the signs add up to 6 with at least one matched by a pattern. Decisive means one of five tactics (codes or passwords, a safe account, a payment that's hard to get back, remote access, coaching you to lie), heard as an explicit ask or a very close match. A coach that cries wolf gets switched off.
- **The score only goes up.** Anything a genuine caller says to reassure you, a scammer can say too.
- **Similarity mostly warns.** Embeddings catch rewordings, but they blur meaning. On a genuine insurance call, "You gave us permission to contact you about potential savings" scored 0.56 against the safe-account examples. So a similarity match gives a warning, and however many add up, they can't say hang up by themselves. The one exception is a very close match (0.65 or more) to a decisive tactic, as with "What's the number on the back of your library card?".
- **Most lines are written to hold up when the detector is wrong.** They avoid claims like "nobody genuine" and never tell you a call is safe. Most hang-up lines add "check another way", so a genuine caller can still be reached after a false alarm. A few lines still generalise, such as "There's no such thing as a safe account".

Speech recognition uses Moonshine rather than Whisper because it was the fastest in a comparison in Chrome (on a 3.45 s clip, using the CPU: Moonshine 108 ms, Whisper tiny 367 ms, Whisper base 663 ms). All three were accurate on clean synthetic speech, so that comparison doesn't show which handles real speech best.

## How well it works

**In short: it catches nearly every scam in generated calls, and only about half of a small set of real ones.** Real calls are the number that matters, and they aren't good yet.

Each call runs through the real detector and coach, one turn at a time. "Spoke" means the caller's words raised the risk to warning level. "Hang up" means they raised it to hang-up level. The last column counts every line telling someone to hang up, including "Stop. If that's a code or bank number, hang up." when they read out a date of birth or a zip code. That line can play below warning level, so the last column isn't always a subset of "spoke".

| Data | Rules written from it? | Scam calls: spoke | Scam calls: hang up | Genuine calls: spoke | Genuine calls: heard hang up |
| --- | --- | --- | --- | --- | --- |
| Public dialogues, train | Yes | 640/640 | 581/640 | 4/640 | 1/640 |
| Multi-agent dialogues, train | Yes | 636/640 | 614/640 | 5/640 | 2/640 |
| Hand-written UK calls | Yes | 15/15 | 13/15 | 0/15 | 0/15 |
| YouTube calls, dev half | Yes | 10/11 | 5/11 | none in set | none in set |
| Public dialogues, test | No, but it shares templates with train | 160/160 | 149/160 | 2/160 | 0/160 |
| **Multi-agent dialogues, test** | **No, but it shares templates with train** | **159/160** | **155/160** | **6/160** | **3/160** |
| **YouTube calls, holdout half** | **No. Calls never read, but scored three times** | **5/9** | **4/9** | **none in set** | **none in set** |

The last two rows are the closest to unseen, and the second-to-last is generated by a language model. Neither generated test split is independent of its training split: 297 of the public test's 320 calls and 255 of the multi-agent test's 320 open with the same 14 words as a training call. At 20 words it's 254 and 172, and 48 of the multi-agent split's 160 scam calls.

On the multi-agent test, insurance sales calls give most of the false alarms (5 of 40 got a warning, 3 of 40 a hang up). On its scam calls, the coach first spoke a median of 20% of the way through.

### What tuning did

I ran the detector on the unseen data before changing anything, then split the YouTube calls in half. An AI reviewer read one half and the rules were changed from what it found. This is the same data before and after.

| Data | Before | After |
| --- | --- | --- |
| YouTube dev half (read while tuning), spoke | 5/11 | 10/11 |
| YouTube dev half, hang up | 2/11 | 5/11 |
| **YouTube holdout half (calls never read, scored three times), spoke** | **5/9** | **5/9** |
| **YouTube holdout half, hang up** | **4/9** | **4/9** |
| Multi-agent test, scam spoke | 159/160 | 159/160 |
| Multi-agent test, scam hang up | 156/160 | 155/160 |
| Multi-agent test, genuine spoke | 15/160 | 6/160 |
| Multi-agent test, genuine told to hang up (caller's level only) | 6/160 | 3/160 |

The holdout has now been scored on three versions of the code, so it's no longer a single blind run. An audit also re-ran the second version and got the same result. Before tuning it gave 5/9 spoke and 4/9 hang up. After tuning it gave 4/9 and 4/9. After the final review's fixes it gave 5/9 and 4/9, exactly where it began. Those final fixes weren't written from it, and its calls haven't been read, though an auditor did print the channel names across all 20 YouTube rows (metadata, no dialogue).

Two things follow from this:

- **The rules overfitted to the real calls the review read.** The half it read doubled and the half nobody read got no better. Some of the original hits were also for the wrong reason, such as a greeting that happened to look like a request for an identity number. The real-call figure is about half, from a small sample. Getting better needs more real data before more rules. On all 20 calls before tuning, the coach spoke on 10 and said hang up on 6.
- **False alarms really did fall.** They came mostly from bugs, like "you won't" matching "you won", and no rule was written from this test set. I had seen its scores before, and the final audit looked at the 3 genuine hang-ups in it, so it isn't perfectly blind.

The YouTube set has limits of its own. It's only 20 calls with no genuine calls to compare against, and the scammers were talking to scambaiters, so they may not have reached the ask. The dataset's card has no description, so its only evidence of origin is a column naming scambaiter channels.

### With spoken audio

The tables above use text. This one speaks the 30 UK calls with six synthetic macOS voices, through the app's real segmenter, Moonshine and detector in Chrome. There are 90 scam and 90 genuine call runs per row.

| Audio | Scam: spoke | Scam: hang up | Genuine: spoke | Genuine: hang up | Word errors |
| --- | --- | --- | --- | --- | --- |
| Clean | 85/90 | 76/90 | 0/90 | 0/90 | 2.1% |
| Simulated phone line | 86/90 | 74/90 | 2/90 | 0/90 | 2.7% |
| Phone line with noise at 15 dB | 81/90 | 58/90 | 6/90 | 0/90 | 12.3% |

The same calls as plain text, in Chrome, give 15/15 spoke, 13/15 hang up and 0/15 false alarms, which is the row to compare against. Noise costs the most, and most of that loss is at "hang up". With perfect words and the same cuts, the rows give 84/90 spoke and 78/90, 78/90 and 79/90 hang up, so the loss in noise comes from misheard words. Every genuine call that got a warning here is the same plumber's call, where cutting the speech into chunks leaves a clause that sounds like a payment demand.

These are synthetic voices reading perfectly, and a simulated phone line (300 to 3400 Hz, with stationary noise). They aren't people or real phone lines, so treat this as a best case.

### Speed

Urgent lines started a median of 443 ms after the chunk of speech that caused them (range 122 to 525 ms over 8 lines in scripted calls, on an M4 Pro). That clock starts when the chunk ends. A chunk ends at a pause, or after 6 seconds, so in a long unbroken sentence an ask near the start can wait several seconds. In listen mode, the one urgent line in the test took 2.3 seconds, because a forced cut goes back to the quietest point and that clock starts there. Other lines wait for a pause, up to 6 seconds in listen mode, and aren't in these figures.

### The coach's wording

A long line talks over the caller, so I shortened the lines and tested what that cost. There are 35 lines, 31 of them spoken during a call. **The reviewers below were AI models and the clarity check was a speech model, not people. No human has listened to these lines.**

| In-call lines | Before | Now |
| --- | --- | --- |
| Median length | 5.8 s | 4.9 s |
| Longest | 7.2 s | 6.5 s |
| Median time until the instruction ends (lines that have one) | 5.8 s | 3.9 s |
| Instruction heard by the speech model, caller at the app's level (0.22) | 279/279 | 279/279 |
| Same, caller louder (0.6) | 245/279 | 254/279 |

The last two rows mix each line with a caller's voice, nine runs per line. Lines with no instruction to hear (6 before, 5 now) count as heard automatically. Among lines that have one, it's 225/225 and 234/234 at 0.22, and 191/225 and 209/234 at 0.6. The app turns the caller down to 0.22 while the coach speaks.

Three independent drafters each rewrote every line: instruction first, true when wrong, plain speech. Blind panels of AI reviewers then scored the wordings out of 5 on whether they were understood, true if the call was genuine, and helpful if it was a scam. They didn't see the length, or which wording was current.

- **Round 1:** no shortened set beat the current lines overall (current 4.01, drafts 3.66, 3.96 and 3.94).
- **Round 2,** the best wording for each line: 3.96 against the current 3.83, with 0 vetoes against 16, but reviewers found lines cut too far.
- **Round 3,** revised, with 4 fresh reviewers: 4.19 against 3.86, with 0 vetoes against 12. Understood 4.30 against 4.01, true if genuine 4.20 against 3.71, helps if scam 4.08 against 3.87. "Would ship" votes 78 against 46.

Afterwards nine lines were adjusted or went back to the old wording, so the shipped set differs from round 3. Five of the nine had a small blind check by three reviewers. The other four didn't: the identity number, personal details and family emergency lines, and the first closing line.

Three cuts did damage: dropping "a number I trust", dropping "if they rang you" (which could cause harm on a 999 call), and putting the reason after "Say:", where it sounds like part of the phrase.

## What hasn't been tested, and known limits

- **Real voices, real phone audio and real users.** None of these has been tested. This is the biggest unknown.
- **It can't run on a real phone call, which is why it's a practice tool.** A browser can't reach call audio and, as far as I could find, nor can a normal phone app on a call it isn't carrying. On iOS, an Apple engineer [answered "No"](https://developer.apple.com/forums/thread/841340) when asked if any supported API allows it. On Android, [`VOICE_CALL` capture](https://developer.android.com/reference/android/media/MediaRecorder.AudioSource#VOICE_CALL) needs a permission reserved for system components. So a real version needs the call routed to it, by a carrier, a phone maker or call forwarding. What I found on 4 November 2026:
  - [Hiya AI Phone](https://www.hiya.com/products/apps/hiya-ai-phone) (iOS and Android, US only) [analyses call audio live](https://blog.hiya.com/ai-deepfakes-pose-a-threat-but-the-hiya-ai-phone-app-fights-back). It appears to get that audio through call forwarding: its App Store release notes mention forwarding set up during onboarding, but I didn't find it stated how the audio reaches the app.
  - Deutsche Telekom's [Magenta AI Call Assistant](https://www.telekom.com/en/newsroom/latest-updates/media-information/2026/3/deutsche-telekom-reimagines-phone-calls-with-ai-embedded-in-the) runs in the network and needs no app, but it notifies everyone on the call, so a scammer would be told too.
  - Call centres already play audio to one person only: a [Twilio "coach" participant](https://www.twilio.com/docs/voice/api/conference-participant-resource) can be heard only by the person being coached.

  The separate caller and person channels here are what that routing would provide. It would also take the audio off the device, as far as I can tell, so the on-device design would need rethinking. I didn't build an iOS app or a real phone line for this submission, because a native app would still need to carry the call.
- **The law.** Nothing is recorded and nothing leaves the device, but I haven't checked the legal position on listening to calls.
- **Headphones are required, and speakers have only been simulated.** With echo cancellation off, the microphone hears the coach on loudspeakers, and its "Hang up" can end a practice call. No real speaker test has been done.
- **In-call lines never say where to find a trusted number.** "Check another way", "the official number" and "a number I trust" don't say where to look. All four final reviewers flagged this. Once anything has stood out, the closing line and the summary screen cover it, but only after the call has ended. After a clean call they only say "check on a number you trust".
- **Backing you up when the caller pushes comes from the script.** A practice call tells the coach when the caller is pressing on. Detecting that from speech isn't built, so it doesn't happen in listen mode.
- **Listen mode has one microphone**, so it can't tell who's speaking. A caller saying "Hang up", "Please hang up" or "Coach, hang up" would end the session. Any other short sentence (up to 7 words) addressed to "Coach", or to a usual mishearing of it such as "Coat", is treated as the person talking and skips the detector. Everything else goes to the detector.
- **A bare "hang up" can be heard as "hang on"**, depending on the voice. "Coach, hang up" worked in every synthetic run, and the button always works.
- **Reading out digits is ignored while nothing has been flagged.** That lets people read out phone numbers on ordinary calls without being stopped, but a code read out that early gets no warning.
- **Known false alarms.** Someone who reads the patterns can find more in minutes.
  - These can get a hang up: "Can you read that back to me?", because it's word for word what a scammer says, and a sales call offering a gift card as a referral reward. That reward accounts for all 3 genuine hang-ups in the multi-agent test row (one of those calls also asks for a social security number).
  - These also get a hang up, and I left them on purpose, because the fixes were very long patterns or one rule per sentence: genuine advice about scams ("No bank will ask you to give your PIN"), any code that isn't on a short list of everyday ones ("What's the code for the garage?"), and some ordinary talk about remote access or gift cards ("We've lost the remote connection to your smart meter", "Can you pick up an Amazon gift card for your sister's wedding?").
  - These get a warning: some genuine refund calls, such as one that also asks you to confirm your address, "You won the raffle", and a 999 operator saying "Stay on the line. Help is coming right now. Can you confirm your address?".
  - A bank asking for your date of birth stays silent unless something else adds up or you answer in digits.
- **Known misses.** Calls that stay in the early stages, before any ask, often go unnoticed, and so do many scam sentences written by hand to get past the patterns. Mishearing one word can also change the outcome: "courier" heard as "Korea" lost one hang up.
- **The control call is an easy one.** The genuine bank call stays silent, but it never asks you for details or money.
- **Left and right panning** comes from the code. It hasn't been checked by ear.

## Testing it

```bash
npm test
```

Runs 224 unit tests in about a second. They include [eval/everyday.json](eval/everyday.json), 96 ordinary sentences and 65 scam sentences that once caused trouble. Most came from an adversarial review and the fixes were written while looking at them, so that shows the bugs stayed fixed, not how accurate it is.

```bash
npm run eval
```

Scores the detector on the tuning data. The default run takes about 3 minutes. Add `-- --independent`, `-- --test`, `-- --youtube-holdout`, `-- --everyday` or `-- --show-misses` for the other sets. It downloads the MiniLM model on first use.

```bash
npm run e2e
```

Runs real calls in real Chrome, including hanging up at awkward moments, microphone tests and working offline: 49 checks on macOS, in about 8 minutes. The tab is unmuted with its sound sent nowhere, because Playwright's default mute once hid a real microphone bug (the offline check is the exception). The microphone is a fake one playing a WAV file, which stands in for headphones, so no real microphone has been tested. Nothing else is mocked.

It needs `npm run dev` running in another terminal, and Chrome installed. Set `E2E_URL` to test another address. The unscripted listen test needs macOS, because it makes its audio with the `say` command, and is skipped elsewhere.

```bash
node scripts/eval-audio.mjs
```

Produces the spoken-audio table. Needs macOS and `npm run dev`, and takes about 15 minutes.

```bash
npm run build
```

Type-checks and builds to `dist/`. The cross-origin isolation headers let the speech models use several threads, which was about twice as fast in one test. Without them it still runs, on one thread. `npm run preview` sets them, and any other host would need to set them too. Stop `npm run dev` first, because they share port 5173.

To change what the coach says, edit [src/coach/lines.ts](src/coach/lines.ts), then record it again. The voice model isn't a normal dependency, because it's large and only needed here.

```bash
npm install --no-save kokoro-js
```

```bash
npm run render-audio
```

## Where to look

| Path | What's there |
| --- | --- |
| [src/detect/tactics.ts](src/detect/tactics.ts) | The tactics: weights, patterns and example sentences |
| [src/detect/detector.ts](src/detect/detector.ts) | Turns speech into a risk level |
| [src/coach/lines.ts](src/coach/lines.ts) | Every sentence the coach can say |
| [src/coach/coach.ts](src/coach/coach.ts) | When to speak, and what the person meant |
| [src/audio/](src/audio/) | Routing and cutting audio into chunks of speech |
| [src/speech/worker.ts](src/speech/worker.ts) | The two models, off the main thread |
| [src/app/session.ts](src/app/session.ts) | One call from start to finish, where it all meets |
| [scripts/](scripts/) | Evaluation, browser tests and recording |

## Credits

- Speech to text: [Moonshine base](https://huggingface.co/onnx-community/moonshine-base-ONNX), through [Transformers.js](https://github.com/huggingface/transformers.js).
- Embeddings: [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2).
- Recorded voices: [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), using [kokoro-js](https://www.npmjs.com/package/kokoro-js).
- Evaluation data, all tagged Apache-2.0 on Hugging Face: [BothBosu/scam-dialogue](https://huggingface.co/datasets/BothBosu/scam-dialogue), [BothBosu/multi-agent-scam-conversation](https://huggingface.co/datasets/BothBosu/multi-agent-scam-conversation) and [436-4/youtube-scam-conversations](https://huggingface.co/datasets/436-4/youtube-scam-conversations).
- The UK calls in [eval/uk-calls.json](eval/uk-calls.json) were written for this project.
- Fraud figures in the write-up: [UK Finance Annual Fraud Report 2026](https://www.ukfinance.org.uk/news-and-insight/press-release/fraud-report-2026-press-release).
