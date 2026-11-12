# Instagram Reel - Parkour and Combat: 90-Second Analysis

## Source

| Item | Value |
| --- | --- |
| File | `FrsotHandler + RaisFight 2.mp4` |
| Path | `D:\NVdia_Recording\FrsotHandler + RaisFight 2.mp4` |
| Media pool id | `c409e5f1-8f25-4b85-8ad5-a7e8618345d5` |
| Duration | 362.232 s (6:02) |
| Frame rate | 60.000114 fps |
| Resolution | 1366x768 |
| Video | H.264, yuv420p |
| Audio | AAC, 48 kHz, stereo |

No other source media is used.

## Analysis method

- Local vision model `qwen3-vl:2b` (Ollama, `http://127.0.0.1:11434`), run on frames extracted with the project FFmpeg pipeline at 320 px long edge.
- Coverage grid: one frame every 4 s from 2 s to 358 s (90 frames), classified into `parkour`, `zombie-combat`, `thug-combat`, `walking`, `menu`, `dark`, `other`.
- Targeted verification: 22 extra frames at 1.5 s spacing inside the parkour candidate window and at the boundaries of the combat windows, plus a 6-frame boundary probe at a higher output budget.
- Model coverage is incomplete: 31 grid frames produced no usable output (empty model response), so boundaries carry roughly +/-2 s uncertainty. All labels below come from model output; no timestamp was invented.

## Selected segments (60 fps, whole frames)

| # | Role | Source in | Source out | Frames | Duration | Timeline in | Timeline out |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Parkour / free-running | 00:02:03.000 (123.0 s) | 00:02:18.000 (138.0 s) | 7380-8280 | 900 (15 s) | 00:00:00.000 | 00:00:15.000 |
| 2 | Frost melee vs zombies | 00:04:52.000 (292.0 s) | 00:05:27.000 (327.0 s) | 17520-19620 | 2100 (35 s) | 00:00:15.000 | 00:00:50.000 |
| 3 | Rais thug street fight | 00:00:18.000 (18.0 s) | 00:00:58.000 (58.0 s) | 1080-3480 | 2400 (40 s) | 00:00:50.000 | 00:01:30.000 |

Total: 5400 frames = 90.0 s exactly.

## Model evidence

| Segment | Observed labels (source time, evidence) |
| --- | --- |
| Parkour 123-138 s | 130 s "stone platforms, parkour environment, game UI, platform jumping"; 134 s "hands on platform, first-person view"; 137.5 s "hand touching wall, brick building, game UI elements" |
| Frost zombies 292-327 s | 294 s "zombie combat character in building"; 298 s "zombie combat, blood, weapon, enemy"; 302 s "zombie combat green outfit weapon"; 305 s "RAIS crate, shotgun, building, UI, zombie combat"; 322 s "blood splatter combat action zombie enemy"; 326 s "blood, weapon, combat, zombie, bloodstains, ground"; 292 s and 327 s both "zombie-combat" |
| Rais thugs 18-58 s | 22 s "gun, urban, street, combat, thugs"; 30 s "street, cars, stop sign, barrel, explosion, HUD"; 50 s "cars, street, combat, thugs"; 38 s and 54 s "zombie, blood, street" (zombies also present in the brawl) |

## Notes and confirmation points

- Boundaries are model-derived, not manually inspected, and are approximate to about +/-2 s. Confirm the three in/out points before approving the edit.
- The parkour window is the strongest continuous free-running evidence found; the block at 110-120 s is HUD/map footage and was excluded.
- The thug window is a street brawl with armed human enemies; ambient zombies appear at its edges, so trim the first/last second if a pure human fight is required.
- No transitions, effects, captions, music or retiming are planned. Whole source ranges only.
- Target timeline: `Instagram Reel - Parkour and Combat v3` (frames 216000-221400 at 01:00:00:00, 5400 frames = 90.000 s). Export is not part of this edit.
