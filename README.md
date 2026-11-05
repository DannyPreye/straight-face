# Straight Face

A game about keeping a straight face, driven by live camera signals from the
[Presage SmartSpectra SDK](https://github.com/Presage-Security/SmartSpectra).

Built for the [DEV Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04).
This is not a medical product. Readings are for play only.

## Setup

You need Node 22.12+, a webcam, and Windows x64, macOS on Apple Silicon or Linux.
The install downloads a few hundred MB.

1. Get an API key at <https://physiology.presagetech.com/auth/register>.
2. Run:

   ```bash
   npm install
   cp .env.example .env   # then add your key to .env
   npm start
   ```

In a VS Code terminal, clear `ELECTRON_RUN_AS_NODE` first or the app exits immediately.
