# weekly-pace

A Claude Code mod: a band above the prompt that shows how much of the weekly quota you have used,
against the pace your usual week allows, with a traffic light.

```
🟢 מכסה שבועית ███████│░░░░░░░ 42% יעד 38% · צפי 91% · איפוס בעוד 3י׳ 4ש׳
```

- **Bar**: quota used so far. The `│` mark is where your usual week stands at this hour.
- **Light**: green up to 10% over target, yellow up to 25% over, red past that
  (never tighter than 2 / 5 points, so early-week noise stays green).
- **Projection**: where you end the week if the rest follows your usual pattern.

## How the usual week is learned

1. **Transcripts**: `scripts/build-profile.mjs` scans the last 91 days of local Claude Code
   transcripts (`~/.claude/projects`) and sums price-weighted tokens per hour. It runs in a
   child `node` process once a day.
2. **Quota readings**: the mod stores the real `seven_day` percentage every 30 minutes.
   Finished weeks phase in over the transcript estimate and replace it after 3 full weeks.

Transcripts cover this machine only; usage on claude.ai or other devices is missing until
the quota readings take over.

## Requirements

- Claude Code on a subscription plan (the `seven_day` window exists only there)
- `node` on `PATH`

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install weekly-pace --marketplace Dyaromim/weekly-pace
```

Answer `y` to add the marketplace, then pick the user scope.

## Develop

```bash
claude plugin validate .
claude plugin test .
```
