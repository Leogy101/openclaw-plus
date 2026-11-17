# Synthetic Models demo

This capture uses the actual OpenClaw+ desktop UI and the independently installed GCB engine. Forge and Scribe are GCB synthetic examples. The model catalog and conversation names are isolated fixtures; their availability is demonstration metadata. No local or cloud model inference is performed.

On Apple Silicon macOS with an active graphical session, install the desktop development dependencies and the reviewed GCB package using their existing instructions. Point `OPENCLAW_PLUS_TEST_GCB` at that installed `gcb` executable, then run from the repository root:

```sh
npm run build:ui --prefix desktop
OPENCLAW_PLUS_TEST_GCB=/absolute/path/to/gcb-venv/bin/gcb node tests/profile-demo-desktop.cjs
```

Run this separately from other Electron tests so windows do not compete for focus. The script creates a fresh fixture profile under `evidence/runs/profile-demo-*`, executes GCB's offline research and profiling workflow, and closes the app afterward. It does not use the production Gateway or modify agent assignments, provider authentication, or routing configuration.

The ordered PNGs show model selection, research, explicit usage review, paused partial evidence, a completed capability bio with reasoning comparisons, a recorded structured response, explainable routing previews, and the light theme. Captures wait for state changes and two animation frames, then use Electron's native `capturePage` output. A visible-text check rejects private filesystem paths before capture.

`demo.json` identifies the synthetic scope and records captions, dimensions, and image hashes. Share only the PNGs and that manifest; keep the adjacent `private-fixture-profile-*` directory local. Review the images before publication. The demo illustrates the workflow and does not establish capabilities of any real model or enable live routing.
