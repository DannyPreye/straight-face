---
title: Straight Face: a party game where your webcam is the referee
published: false
tags: devchallenge, presagechallenge, gamedev, javascript
---

*This is a submission for the [Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04)*

<!-- TODO before publishing: add the demo video, and one or two lines in your own words on why you made it. -->

## What I Built

Straight Face is a party game. You pass the laptop around, and the webcam decides who cracks first.

There are three modes. In Straight Face, a new prompt pops up every six seconds and tries to make you smile ("A duck is now your landlord. He wants the rent in bread."). The moment the SDK sees a real smile, you're out. Last 45 seconds and you're unbreakable. Staring Contest is simpler and somehow worse: the first blink loses.

The third mode is the come-down. Cool Down is a 90-second breathing round. A guide starts at the breathing rate the SDK just measured for you, your own pace, and eases toward six breaths a minute. Your actual chest movement is drawn live next to the guide, and your score is how closely you follow it. Breathing at your own speed and ignoring the guide scores low.

When your round ends you get a card with your time, the line that broke you and, if you turned it on, a photo of the exact second your face gave up. Up to eight people can play, and the scoreboard keeps everyone's best time for the night.

There are two prompt packs. One is general silliness. The other is Naija: NEPA taking light right when you say "let me just quickly...", the jollof we have at home, the aunty at the owambe asking when we're eating your rice. If you grew up with any of that, good luck keeping a straight face.

## Demo

<!-- TODO: embed the demo video. Show the Signal lab readings, one round of each mode and a cracked card. -->

## Code

{% github DannyPreye/straight-face %}

## How It Responds to Human Signals

| Signal | What it does in the game |
| --- | --- |
| Expression scores | The "happy" score drives the Crack-o-meter. Hold 50% or more for a quarter of a second and you've cracked. |
| Blink detection | One blink after "Go" ends a Staring Contest round. The cartoon eyes on screen blink with you. |
| Validation status | Shows lighting and framing hints. If the SDK loses your face for 1.5 seconds, the round doesn't count. |
| Pulse rate | Shows in the top bar once the SDK is confident, and your result says what it was at the start and end of the round. |
| Breathing rate | Sets where the Cool Down guide starts. |
| Breathing waveform | Drawn live against the guide. Every second I correlate the last 15 seconds of both (allowing your breath to trail by up to 3 seconds), and the round score is the average. |

It's an Electron app on `@smartspectra/node-sdk`. The window captures the camera and the SDK runs in the main process. I wrapped the SDK in a single session object that turns its metrics into plain events (expression, blink, breathing waveform, vitals), and all three modes and a Signal lab screen listen to those. The Signal lab shows every reading live, how long each one takes to warm up, and a reaction test that times how fast a smile registers.

<!-- TODO after playtesting: add real numbers from the Signal lab (median smile lag, expression updates per second) and what you tuned because of them. -->

A few things I learned the hard way:

- Pulse needs about 12 seconds of data, breathing 30 and HRV 60. That's far too slow for a twitch mechanic, so the fast modes run on expressions and blinks. Breathing got its own slower mode instead, where the warm-up fits naturally.
- Light matters more than I expected. My first test frames measured 7 out of 255 for brightness, and the SDK just gave up a few seconds in. Now the app checks brightness before it starts and tells you to turn on a lamp instead of failing mid-round.
- The SDK talks to Presage's servers during a session to download models and check usage, so a flaky connection can end one. My connection dropped about one request in twenty. The app now reconnects on its own (up to twice) and voids the interrupted round, so nobody loses because of the Wi-Fi.

## Prize Categories

Most Creative or Delightful Use, and Best Thoughtful Real-World Use for the Cool Down mode.

<!-- TODO: what inspired it, in your own words. -->

## Consent and Data Handling

The camera stays off until you reach the camera check step, which says what the camera is for and that nothing is recorded. It turns off when you go back home, close the app, or leave it idle for three minutes. The SDK reads one face at a time, and every player sits down to play on purpose.

The app saves no video and no readings. There are no accounts and no analytics.

The cracked-card photo is off by default. If you switch it on, the photo lives only in memory and is thrown away at the next round or when you close the app. It only becomes a file if you press Save card.

Video frames go to the SmartSpectra SDK inside the app, and the SDK contacts Presage's servers to check the API key, download its models and record usage. I turned SDK telemetry off (`enableTelemetry: false`). The game doesn't use any AI service, including the SDK's optional LLM Insights.

The readings are for play. Nothing in the game diagnoses anything or tells you what your pulse means.

## Agent Session

<!-- Optional. Upload only the build portions of the transcript, check it for keys first, and make it public before publishing. -->
