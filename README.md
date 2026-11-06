# Straight Face

A party game you play with your face. Your webcam reads your expression and blinks in real time
through the [Presage SmartSpectra SDK](https://github.com/Presage-Security/SmartSpectra), and the
moment you smile (or blink) you're out.

Built for the [DEV Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04).
This is a game, not a medical product. Readings are for play only.

## How it flows

1. **Pick a game.** Three tiles, one choice.
2. **Players.** Names, plus how that game works in three lines.
3. **Camera check.** A live preview and a checklist that ticks itself: connected, enough light, face in view,
   and for Cool Down, chest in view. Start unlocks once they're green.
4. **Play.** Take turns. Results show on the stage with a shareable card.

## Modes

- **Straight Face**: a new prompt appears every 6 seconds and tries to make you smile. If the SDK's
  "happy" expression score holds at 50% or more for a quarter of a second, you've cracked. Last 45
  seconds and you're unbreakable.
- **Staring Contest**: the first blink the SDK detects ends your round. Last 60 seconds and you're
  unbreakable.
- **Cool Down**: a 90-second breathing round. A guide starts at the breathing rate the SDK measured for
  you and eases toward six breaths a minute (each breath 40% in, 60% out). Your chest waveform is drawn
  live against it, and your score is how closely the two move together.

Up to 8 players take turns in front of one camera. The scoreboard keeps each player's best time for the
evening (it resets when you go back home).

## Signals used

| Signal | What it does in the game |
| --- | --- |
| Expression scores | Drive the Crack-o-meter and end a Straight Face round |
| Blink detection | Ends a Staring Contest round, and the on-screen eyes blink with you |
| Validation status | Shows framing and lighting hints; a round doesn't count if your face is lost for 1.5 seconds |
| Pulse rate | Shown in the top bar once the SDK is confident, and as "before → after" on the result |
| Breathing rate | Sets where the Cool Down guide starts |
| Breathing waveform (upper chest) | Drawn live against the guide; the sync score compares the two |

The **Signal lab** screen shows every reading live, how long each takes to warm up, and a reaction
test that times how quickly a smile registers.

## Setup

You need Node 22.12+, a webcam, a stable internet connection, and Windows x64, macOS on Apple Silicon
or Linux. The install downloads a few hundred MB.

1. Get an API key at <https://physiology.presagetech.com/auth/register>.
2. Run:

   ```bash
   npm install
   cp .env.example .env   # then add your key to .env
   npm start
   ```

In a VS Code terminal, clear `ELECTRON_RUN_AS_NODE` first or the app exits immediately.

### Getting good readings

- **Light your face from the front.** The app measures brightness before it starts and won't run in a
  dark room.
- **One face in frame,** facing the camera. For Cool Down, sit back so your upper chest is in view and keep
  the laptop on a table: breathing is read from chest movement.
- **A steady connection.** The SDK talks to Presage's servers during a session. If the connection drops,
  the app reconnects up to twice and doesn't count the interrupted round.

## Privacy

- The camera turns on only when you reach the **Camera check** step (or press **Turn on camera** in the
  signal lab), and turns off when you end the game, go back, or close the app. After 3 idle minutes it turns
  off by itself.
- Video frames go to the SmartSpectra SDK running in the app. The SDK contacts Presage's servers to
  authenticate your key, download its models and record usage. SDK telemetry is turned off
  (`enableTelemetry: false`). See Presage's
  [telemetry and privacy notes](https://github.com/Presage-Security/SmartSpectra/blob/main/docs/telemetry-and-privacy.md).
- The app saves no video and no readings, and has no accounts or analytics.
- The **Cracked card** photo is off by default. If you turn it on, the photo exists only in memory and
  is discarded at the next round or when you close the app. It becomes a file only if you press
  **Save card**.

## Project layout

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process; camera-only permission for the bundled page |
| `src/session.js` | One SDK session: lighting check, reconnects, signal events |
| `src/app.js` | Screens, game rounds, scoreboard, Signal lab |
| `src/decks.js` | Prompt packs (original writing) |
| `src/card.js` | Result card rendering |
| `src/cooldown.js` | Breathing guide, waveform drawing and sync score |
| `build.mjs` | Bundles the renderer and injects the API key from `.env` |

## License

MIT for this project's code. The SmartSpectra SDK is proprietary to Presage and is used under [its own terms](https://physiology.presagetech.com/tos).

### How the sync score works

Every second, the app takes the last 15 seconds of the guide and of your measured chest movement, resamples both to
10 Hz and computes their correlation, letting your breath trail the guide by up to 3 seconds (the SDK's waveform
arrives a little after the movement). The best match becomes that second's sync, and the round score is the average.
Breathing at your own pace while ignoring the guide scores low; following it scores high.
