# JadeDeath + Tahir Fight: Partial Video Re-analysis

**Status: PARTIALLY VERIFIED**  
**Final acceptance of a complete event analysis: NOT ACCEPTED**  
**Analysis state: stopped at the user's request on 2026-11-06**

This report contains only captured model responses and their sampled-frame timestamps. The event intervals below are **review windows derived from the spacing between neighboring samples**. They are not verified event boundaries or edit points.

## Source and analysis configuration

| Item | Captured value |
|---|---|
| Source | `D:\NVdia_Recording\JadeDeath + Tahir Fight.mp4` |
| Duration | 1,181.281 seconds (19:41.281) |
| Video | 1366×768, H.264, approximately 60 fps |
| Audio | AAC stereo; transcription was not run |
| Vision model | `qwen3-vl:2b` through local Ollama |
| Ollama version | 0.40.14 |
| Context | 4096 |
| Image batch | 1; sequential requests |
| Keep-alive | 45 minutes |
| GPU allocation evidence | `/api/ps` reported 1,911,711,334 of 2,337,653,389 model bytes in VRAM (about 18.2% CPU offload), under the 20% limit |

The model was unloaded after stopping. `ollama-after-user-stop.json` records an empty `/api/ps` model list. No Resolve project, timeline, source video, or editor operation was changed.

## Coverage and stopping point

The worker extracted 40 JPEG samples at 384×216, spaced approximately 29.5 seconds apart, across the 19:41 source. Qwen produced 38 parseable first-pass responses, from 00:14.768 through 18:27.451. The sample at 18:56.983 timed out in the original run and returned empty content on a later recovery attempt. The final extracted sample at 19:26.515 was not processed by Qwen.

The original live run reached its 60-minute deadline during the 18:56.983 request. The saved log contains 38 parsed frame responses plus retries and failures. A continuation attempt failed on empty model content before event refinement. A subsequent recovery was stopped while scene detection was running, at the user's request. **The production refinement pass did not complete and no final structured analysis was returned.**

Scene detection was enabled. An earlier saved status says a scan completed before inference, but its cut list was not persisted. The recovery running at stop had not yet saved a scene list.

## Captured chronological moments

Each “review window” is a bracket around a sampled frame, calculated from the midpoints to its adjacent sample timestamps. The frame time is the actual point sent to Qwen. **Do not use the review window as a confirmed event duration.**

| Review window | Sample time | Captured model description | Evidence and confidence | Status / limits |
|---|---:|---|---|---|
| 00:59.060–01:28.602 | 01:13.835 | “INFECTED KILLED” notification; weapon and blood splatters | Qwen cited visible notification text and blood near the weapon. Confidence 0.9 for the notification, 0.8 for the combat description. | PARTIALLY VERIFIED. A single-frame notification does not establish the surrounding combat sequence. |
| 01:58.126–02:27.660 | 02:12.885 | Weapon held; Qwen called it a “Scorpion gun” and interpreted the image as aiming setup | Qwen returned the weapon-in-hand observation. Confidence 0.9. | PARTIALLY VERIFIED. Weapon identity and action interpretation are model claims; no exchange is shown by this sample. |
| 11:19.234–11:48.767 | 11:34.000 | Jade-labeled subtitle: “One of us has to live... You just remember what you promised me.” Qwen also described a person kneeling/on the floor. | The response had confidence 0.9 but no structured evidence item. The saved frame shows a woman on the floor and the same visible subtitle. This is on-screen text, not an audio transcript. | PARTIALLY VERIFIED. Supports a moment in a Jade scene, not her death moment or sequence boundaries. |
| 11:48.767–12:18.300 | 12:03.534 | “Characters facing each other in a confrontation.” | Qwen cited the confrontation; confidence 0.9. | PARTIALLY VERIFIED. The characters are not identified. |
| 12:18.300–12:47.834 | 12:33.066 | Two people on a balcony; subtitle: “For the natural order of things, Cranes. Kill or be killed. Eat or be eaten.” | Qwen cited the figures and visible subtitle; confidence 1.0. | PARTIALLY VERIFIED. Neither person is identified. This does not prove a mind-game scene or a Rahim/Amir appearance. |
| 12:47.834–13:17.359 | 13:02.601 | Close view of an injured person on the ground | Qwen described visible injuries; confidence 0.9. | PARTIALLY VERIFIED. The model did not identify the person; it cannot be assigned to Jade from this response. |
| 13:46.891–14:16.425 | 14:01.666 | “Enemy approaching from right” in a dark museum setting | Qwen evidence says an enemy is approaching from the right; confidence 0.9. | PARTIALLY VERIFIED. One frame does not establish a complete fight or identify Tahir. |
| 18:12.684–18:42.217 | 18:27.451 | Character with a long weapon near a fallen figure and bloodstains | Qwen gave this description with confidence 0.9. Its event start/end values were invalid (`0.0`), so only the sampled frame time is retained. | PARTIALLY VERIFIED. The next frame sample did not produce a usable Qwen response. This does not identify Tahir or establish a fight conclusion. |

These windows are supplied so the user can review the captured moments in a media player. They are intentionally wider than an edit in-point/out-point would be.

## The three remembered moments

| Moment | Result | What the saved evidence supports |
|---|---|---|
| Jade's death | PARTIALLY VERIFIED | At 11:34 the sampled frame contains a Jade-labeled subtitle and a person on the floor; at 13:02 Qwen reports an injured person. The death itself, the start of the sequence, the person's identity in the later frame, and the immediate aftermath were not established. |
| Tahir fight | NOT FOUND | The saved model responses include generic combat/encounter imagery at 14:01 and 18:27, but do not identify Tahir or describe a complete fight. Do not attribute these samples to Tahir based on the filename or memory. |
| Rahim and Amir appearing in Crane's mind during Jade's manipulation | NOT FOUND in captured evidence | No saved Qwen response identifies Rahim or Amir. The 12:33 balcony response describes two unidentified people and a subtitle, without establishing the hallucination or manipulation context. This is not evidence that those scenes are absent from the video. |

## Output quality and limitations

- Only 38 of the 40 sampled frames produced parseable Qwen responses. Parseable JSON did not guarantee valid timestamps or useful event descriptions.
- Several responses used time `0.0` or the full video duration instead of the image timestamp. Those candidates were excluded from the timeline. Other responses were vague, duplicated, or had no evidence field.
- Qwen returned dialogue-like text at other timestamps, but there is no audio transcript and those strings were not used as verified dialogue. The two quotes in the timeline above were returned as visible on-screen text and are labelled as subtitles.
- Sampling every ~29.5 seconds can miss short actions and cannot establish event boundaries. The beginning, final 74 seconds of usable model coverage, and all between-sample action remain uncertain.
- The requested dense pass around candidates and the dedicated Rahim/Amir visual check did not run.
- Only this gaming video was analyzed; generalization to other content types is NOT TESTED.

## Evidence files

- `data/analysis-cache/results/jadedeath-tahir-fight-reanalysis/source-metadata.json` — source probe result.
- `data/analysis-cache/results/jadedeath-tahir-fight-reanalysis/partial-run-status.json` — 40 extracted sample timestamps and frame hashes.
- `data/analysis-cache/results/jadedeath-tahir-fight-reanalysis/vision-requests-ddd4124f-871f-44b7-ab0d-27472c96a716.jsonl` — original live Qwen requests, responses, and failures.
- `data/analysis-cache/vision-requests/ddd4124f-871f-44b7-ab0d-27472c96a716-resume.jsonl` — failed continuation warm-up and empty responses.
- `data/analysis-cache/results/jadedeath-tahir-fight-reanalysis/analysis-tool-error-run02.json` and `run02-status.json` — overall timeout evidence.
- `data/analysis-cache/results/jadedeath-tahir-fight-reanalysis/ollama-runtime-run02.json` — local Ollama version, model allocation, and GPU snapshot.
- `data/analysis-cache/results/jadedeath-tahir-fight-reanalysis/ollama-after-user-stop.json` — model unload confirmation.
- `data/analysis-cache/results/jadedeath-tahir-fight-reanalysis/partial-event-timeline.json` — machine-readable version of the moments and review windows in this report.
- `data/analysis-cache/results/jadedeath-tahir-fight-reanalysis/sampled-frames-pass1/` — extracted JPEG samples.

## Final decision

**PARTIALLY VERIFIED evidence; NOT ACCEPTED as a complete real-video event analysis.** The captured outputs provide a few useful review points, but they do not establish Jade's death sequence, the Tahir fight, or the Rahim/Amir mind-game appearances. No further live analysis was run after the user asked to stop.
