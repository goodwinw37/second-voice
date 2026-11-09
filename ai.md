# How AI was used

## Tools, and how the work was split

I built this with **Claude Code** (desktop app, Claude Opus 5.5).

1. **Research and ideas (Claude).** It researched what Hiya and Google already ship, and which speech models could run in a browser, then brainstormed three ideas with their trade-offs.
2. **The choice (me).** I picked the live scam-call coach. It was the option Claude recommended, and it flagged that it overlaps with what Hiya and Google already ship.
3. **Code and tests (Claude).** It wrote the code, the unit tests, the browser tests and the evaluation scripts.
4. **Testing to steer each round (both of us).** Claude ran the full test suite, the browser tests and the evaluations after each change, and independent AI reviewers tried to break the product. I also ran the full tests on the product myself, to check everything worked correctly. I used the results to decide what came next: no native iOS app and no paid or real phone line for this submission, testing whether shorter coach lines could stay good rather than simply cutting them, and GitHub rather than a zip.

Each round of AI review ended with a sceptical agent trying to refute the findings before anything was fixed. The coach's wording was compared by blind panels of AI reviewers. They only read the words, so they can't tell how a line sounds, or whether a frightened person would follow it.

## AI inside the product

| Model | Job | Where it runs |
| --- | --- | --- |
| Moonshine base | Speech to text | In the browser, at run time |
| all-MiniLM-L6-v2 | Matches reworded sentences to known tactics | In the browser, at run time |
| Kokoro-82M | Recorded the coach and practice call voices | Ahead of time. Not used at run time |

There is deliberately no large language model in the loop. Patterns, a similarity model and fixed rules decide which line the coach plays, and every line was written in advance. A caller's speech is untrusted input: a language model that listens to a scammer and speaks to their victim can be manipulated by what the scammer says.

## What the AI got wrong

The first version looked finished and passed its own tests, and it still had serious bugs. Most were found by running the system, not by reading the code. These five taught me the most:

1. **The page froze when you did what the coach said.** Pressing Hang up while the coach was talking sent a loop into an endless spin. The tests had only ever hung up at safe moments. An AI reviewer told to break things found it.
2. **Rules that didn't carry over to real calls.** Rules written after reading half the YouTube scam calls took that half from 5/11 to 10/11. The half kept unread ended where it began, at 5/9. The README has the full history.
3. **The evaluation hid the most common false alarm.** It only looked at the caller's turns, and reported 19 of 640 genuine calls told to hang up. Playing both sides through the real coach showed 95 of 640: someone giving their address was told to stop and hang up.
4. **False statements in the coach's mouth.** Lines like "Nobody genuine asks for it on a call" aren't true, and they played on false alarms. The closing line also said "Well done" to someone who had just read out a code. The lines were rewritten to hold up when the detector is wrong.
5. **Safety checks that couldn't hear.** The voice read the bank number 159 as "one hundred and fifty nine", because the check on the recordings looked at the text, not the sound. And the browser tests ran muted, which hid the mic going deaf during playback. That fix is why the app now needs headphones.
