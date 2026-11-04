# How AI was used

## Tools used to build this

**Claude Code** (desktop app, Claude Opus 5.5) did most of the work:

- researched what Hiya and Google already ship, and which on-device speech models were practical
- proposed three ideas with their trade-offs
- wrote the code, tests, evaluation scripts and first drafts of the docs
- ran the app in real Chrome through an automated test, and fixed what that exposed
- ran a second pass of independent AI reviewers, each told to break one part (hanging up at bad moments, coach logic, safety of the wording, synthetic voices, real-call misses, false alarms). A sceptical agent then tried to refute each code, logic and safety finding before it was fixed.
- ran a final audit after those fixes. AI reviewers checked the documents against the code and the measured numbers, looked for new bugs, and followed the README from a clean copy. A sceptical agent again tried to refute the findings.
- ran blind panels of AI reviewers on the coach lines. They scored each wording on whether it would be understood, whether it was true if the call was genuine, and whether it helped if the call was a scam, without seeing its length or which version was current. That shows which wording other AI models prefer. They only read the words, so they can't tell me how a line sounds, or whether a frightened person on a call would follow it.

Two things to disclose about the YouTube calls. An auditor printed the channel names across all 20 rows, including the unread half. That was a small slip: metadata only, with no dialogue. And the unread half was scored three times, on three versions of the code, not once (item 14). An audit also re-ran it on unchanged code to confirm the figures, and got the same result.

**My part:** I chose the idea from Claude's three options. I took the one it recommended, which it flagged as overlapping with what Hiya and Google already ship. I also decided on no native iOS app and no paid or real phone line for this submission, and on GitHub rather than a zip. And I asked to test whether shorter coach lines could stay good, rather than simply cutting them.

<!-- WILLIAM: replace this comment before submitting. Say what you actually did: which code you read and changed, what you tested with your own voice, and which decisions you changed or pushed back on. -->

## AI inside the product

| Model | Job | Where it runs |
| --- | --- | --- |
| Moonshine base | Speech to text | In the browser, at run time |
| all-MiniLM-L6-v2 | Matches reworded sentences to known tactics | In the browser, at run time |
| Kokoro-82M | Recorded the coach and practice call voices | Ahead of time. Not used at run time |

There is deliberately no large language model in the loop. Patterns, a similarity model and fixed rules decide which line the coach plays, and every line was written in advance. Someone being pressured on a call shouldn't hear improvised advice, and a caller's speech is untrusted input: a language model that listens to a scammer and speaks to their victim can be manipulated by what the scammer says.

## Where the AI got things wrong

Most of these were found by running the system, not by reading the code. That is the main lesson from building this way: the first version looked finished and passed its own tests, and it still had a bug that froze the page.

**While building it:**

1. **A first setting that did nothing.** The semantic matcher's initial threshold added almost nothing over plain patterns (68.4% against 68.1% of scams). A sweep of settings found where it helped.
2. **A score that looked too good.** Tuning reached 100% of scams on the training data. The held-out split turned out not to be independent: 297 of its 320 calls open with the same 14 words as a training call. Of two other datasets, the generated one still scored 159/160, but calls taken from YouTube scored 10/20.
3. **A silent hang.** A missing header on the speech runtime made the browser block its worker threads, so loading waited forever with no error. Logging found it.
4. **Words cut in half.** A fixed 4-second chunk cut through words, and the speech model invented replacements. "Rent is due today" came out as "rent is due to death".
5. **A warning cut off.** A queued low-priority line interrupted a more urgent one after about a second.
6. **Not listening at the wrong moment.** The microphone was ignored while the caller or coach was talking, so "hang up" could be missed.
7. **Telling someone on a genuine call to hang up.** The speech model wrote "PIN" as "P. I. N.", the full stops split the sentence, and "we will never ask" got separated from "your full password". The genuine bank call in the end-to-end test caught it, on a run after the same call had passed.
8. **Flattering numbers.** Reply latency was first measured from after transcription, which showed 0 ms. It now runs from when the chunk of speech ended.

**Found by the independent review, after all the tests were passing:**

9. **The worst bug: the page froze when you did what the coach said.** Pressing Hang up while the coach was talking sent a loop into an endless spin that stopped the browser reporting the clip had finished. About a quarter of the bank call was in this window. The tests had only ever hung up at safe moments.
10. **A scammer could switch it off.** In listen mode, one microphone hears both people. "If you hang up now, your money will be gone" was taken as the person saying "hang up", and the coach then said nothing had worried it.
11. **"Hang up." was heard as "H".** The speech library allows 6 tokens per whole second, rounded down, so a short command got almost none. The model comparison had measured speed and accuracy, but never on short commands.
12. **The evaluation hid the most common false alarm.** It only looked at the caller's turns, and reported 19 of 640 genuine calls being told to hang up. Playing both sides through the real coach showed 95 of 640: someone saying "It's 123 Oak Road" was told "Don't read that out. Hang up now."
13. **A confident explanation that was wrong.** The first draft of the notes said insurance calls gave the most false alarms because sales calls use similar pressure. Reading the calls showed it was mostly bugs: "zip code" counted as a secret code, a gift card offered as a reward counted as a demand for one, and "you won't" matched "you won". The gift-card fix only narrowed that bug: it still causes all 3 genuine hang-ups on the multi-agent test split.
14. **Rules that didn't carry over to real calls.** Rules written after reading half the YouTube calls took that half from 5/11 to 10/11 on the coach speaking. The half kept unread went from 5/9 to 4/9. The review predicted the first figure would be optimistic. The unread half is the one to believe. It was scored a third time after the final fixes, which weren't written from it, and came back to 5/9, exactly where it began. Its hang up figure stayed at 4/9 all three times.
15. **False statements in the coach's mouth.** "Real organisations write to you first" and "Nobody genuine asks for it on a call" are not true, and they were spoken as fact on false alarms. Several lines were rewritten to be true even when the detector is wrong, though a few still generalise. The closing line said "Well done" to someone who had just read out a code.
16. **The app and the evaluation ran different numbers.** The 8-bit embedding model gave slightly different results in Node and in Chrome, and even depending on what else was in the batch. Both now use the 16-bit model, where the batch differences are over 100 times smaller. On the UK calls, the text-only scores in Chrome and Node match.

**Found by the final audit and blind reviews, after the second review's fixes:**

17. **The safety lines read the number wrong.** The closing lines tell people to ring 159 to reach their bank, and the voice read it as an amount: "one hundred and fifty nine". Nobody had listened, and the check on the clips hashed the text, not the sound, so it saw nothing wrong. Running the speech model over the shipped clips showed it. The voice is now given "one five nine", and "nine nine nine" for 999, while the screen keeps the figures. The speech model now hears those words in the clips, but no person has listened to them.
18. **Tests that ran muted.** Playwright mutes headless Chrome by default, so the browser tests ran with no sound coming out of the tab. With the tab audible, Chrome's echo canceller made the mic deaf or garbled during playback. With a fake microphone, "Hang up." came through correctly at 4 of 7 points in a call, against 7 of 7 with it off. Removing only the mute made the test for saying "hang up" over the audio fail. Echo cancellation is now off and the tests run unmuted, with the sound sent nowhere. The cost is that the app now requires headphones: without them the mic hears the coach, and "Hang up" can end a practice call.
19. **The docs claimed more than the code did.** The README said the coach says "hang up" only on something decisive, but it also says it once signs add up to a score of 6. It also said similarity alone could only warn, yet similarity matches could add up to "hang up". One sentence was enough: "We'll transfer the balance to your account once the claim is settled." The first was a correction to the docs. The second was a change to the code: adding up now needs at least one explicit pattern match. One very close match to a decisive tactic (0.65 or more) can still say it alone.
20. **The test split I trusted wasn't independent either.** Item 2 caught this on the public split, but the README went on calling the multi-agent test split one of the rows to trust. The audit ran the same check on it: 255 of its 320 calls open with the same 14 words as a training call, and 172 with the same 20. It's less templated on the scam side, where 48 of 160 share 20 opening words. No rule was written from it, but 159/160 says less about new calls than it looks.
21. **A refusal said slowly could count as agreement.** The person's speech is cut into chunks at 2.5 seconds. At about 125 words a minute, "I'll call you back on a number I trust." split in two. The first part counted as the refusal, the leftover "Trust." became the answer to the caller's next line, and an unclear answer takes the same route as agreement. At the test voice's default speed it joined up fine, which is why this hadn't shown. The chunks of one answer are now joined, though a long pause can still split one. This only affects practice calls, because only they have scripted next steps.
22. **Cutting the coach lines made them worse.** Three AI drafters each rewrote every line to be shorter. In blind review, none of those sets beat the existing lines (3.66, 3.96 and 3.94 against 4.01). The damage was specific: dropping "a number I trust", dropping "if they rang you", which could cause harm on a 999 call, and putting the reason after "Say:", where it sounds like part of the phrase. It took two more rounds before a revised set clearly won, at 4.19 against 3.86, with 0 vetoes against 12. Nine lines were then adjusted or put back, five of them with a small blind check, so what shipped differs from what was scored. The median in-call line went from 5.8 s to 4.9 s. All four final reviewers flagged the same open risk: "check another way", "the official number" and "a number I trust" never say where to find the number during the call. Only the closing line and the summary screen do, and not after a clean call.

## What has not been checked

AI can't do these, and none has been done yet:

- testing with real human voices, accents and real phone audio
- testing with the people this is for
- a person listening to it. No person has heard the final coach lines, or checked by ear that the caller is in the left ear and the coach in the right. The lines have only been judged by AI reviewers and a speech model.
- a real microphone and real speakers. The browser tests use a fake microphone, and what happens without headphones has only been simulated.
