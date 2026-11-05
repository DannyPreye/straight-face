---
title: Straight Face: a party game your webcam referees
published: false
tags: devchallenge, presagechallenge
---

*This is a submission for the [Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04)*

<!-- DRAFT. Fill the TODOs after real playtests. Run the humanizer pass before publishing. -->

## What I Built

Straight Face is a party game where the referee is your webcam. Pass the laptop around, and the
SmartSpectra SDK watches each player's face in real time.

- **Straight Face mode:** prompts pop up every few seconds and try to make you smile. The moment your
  smile registers, you've cracked.
- **Staring Contest mode:** the first blink loses.

When you're out, you get a result card with your time and the line that broke you. If you opt in, it
also shows a photo of the exact moment you cracked.

<!-- TODO: one sentence on why you made it, in your own words. -->

## Demo

<!-- TODO: embed the demo video. Show the Signal lab readings, one Straight Face round, one Staring
Contest round, and a cracked card. -->

## Code

<!-- TODO: public repo link. -->

## How It Responds to Human Signals

| Signal | What it does |
| --- | --- |
| Expression scores | The "happy" score drives the Crack-o-meter. Holding 50% or more for 250 ms ends the round. |
| Blink detection | One blink after "Go" ends a Staring Contest round. |
| Validation status | Framing and lighting hints. If your face is lost for 1.5 seconds, the round doesn't count. |
| Pulse rate | Shown live once the SDK is confident, plus your pulse at the start and end of the round. |

How it's wired: the app uses the Node/Electron SDK's renderer entry point, so the window captures the
camera and the main process runs the SDK. One shared session turns raw metrics into simple events
(expression, blink, vitals), and both game modes and the Signal lab listen to those.

<!-- TODO after playtests: real numbers from the Signal lab (median smile lag, expression update rate)
and anything you tuned because of them. -->

Things I learned about the SDK along the way:

- Pulse needs about 12 seconds of data, breathing 30 and HRV 60, so fast game mechanics run on
  expressions and blinks, and pulse is a bonus.
- Lighting matters a lot. The app measures brightness before starting and refuses to run in the dark,
  rather than failing halfway through a round.
- The SDK talks to Presage's servers during a session, so a dropped connection can end it. The app
  reconnects automatically and doesn't count the interrupted round.

## Prize Categories

Most Creative or Delightful Use.

<!-- TODO: what inspired it, in your own words. The Naija prompt pack is a good angle. -->

## Consent and Data Handling

- **Consent:** the camera stays off until a player presses Play or Turn on camera, and the home screen
  says what happens before you press it. The camera turns off when you go home, close the app, or after
  3 idle minutes. Only one face is read at a time, and every player sits down to play on purpose.
- **Storage:** the app saves no video and no readings. There are no accounts and no analytics.
- **Cracked card photo:** off by default. When it's on, the photo exists only in memory and is discarded
  at the next round or when the app closes. It's written to disk only if the player presses Save card.
- **Sharing:** frames go to the SmartSpectra SDK in the app. The SDK contacts Presage's servers to
  authenticate, download its models and record usage.
- **SDK telemetry:** turned off (`enableTelemetry: false`).
- **AI services:** none. The SDK's optional LLM Insights feature isn't used.
- **No health claims:** readings are for play only. Nothing in the game diagnoses or interprets them.

## Agent Session

<!-- Optional. Upload only the build portions of the transcript, check for keys first, and make it
public before publishing. -->
