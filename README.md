# Straight Face

A party game you play with your face. Your webcam reads your expression and blinks in real time
through the [Presage SmartSpectra SDK](https://github.com/Presage-Security/SmartSpectra), and the
moment you smile (or blink) you're out.

Built for the [DEV Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04).
This is a game, not a medical product. Readings are for play only.

## Modes

- **Straight Face**: a new prompt appears every 6 seconds and tries to make you smile. If the SDK's
  "happy" expression score holds at 50% or more for a quarter of a second, you've cracked. Last 45
  seconds and you're unbreakable.
- **Staring Contest**: the first blink the SDK detects ends your round. Last 60 seconds and you're
  unbreakable.

Up to 8 players take turns in front of one camera. The scoreboard keeps each player's best time for the
evening (it resets when you go back home).

## Signals used

| Signal | What it does in the game |
| --- | --- |
| Expression scores | Drive the Crack-o-meter and end a Straight Face round |
| Blink detection | Ends a Staring Contest round, and the on-screen eyes blink with you |
| Validation status | Shows framing and lighting hints; a round doesn't count if your face is lost for 1.5 seconds |
| Pulse rate | Shown in the top bar once the SDK is confident, and as "before → after" on the result |

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
- **One face in frame,** facing the camera.
- **A steady connection.** The SDK talks to Presage's servers during a session. If the connection drops,
  the app reconnects up to twice and doesn't count the interrupted round.

## Privacy

- The camera turns on only when you press **Play** or **Turn on camera**, and turns off when you go home
  or close the app. After 3 idle minutes it turns off by itself.
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
| `build.mjs` | Bundles the renderer and injects the API key from `.env` |
