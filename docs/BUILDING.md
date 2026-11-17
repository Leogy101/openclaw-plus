# Building and verifying OpenClaw+

## Prerequisites

Use Apple Silicon macOS for packaging and native desktop verification. Build tools require Node.js **22.12 or newer**. Live gateway connections additionally use the fixed Homebrew paths and runtime requirements documented in the [README](../README.md#before-you-start). The tested OpenClaw **2026.11.1** requires Node **24.16–24.x or 26.1 and newer**.

From the repository root:

```sh
npm ci --prefix desktop
npm run setup:electron --prefix desktop
npm run build:ui --prefix desktop
```

The lockfile pins dependencies. Installation and Electron setup need their upstream download services. Electron's runtime download is an explicit step; `npm ci` does not perform it automatically. Do not run package installation as part of ordinary app startup.

## Run locally

```sh
npm start --prefix desktop
```

An active macOS graphical session is required. This development app connects to the existing default OpenClaw installation; it is not an isolated gateway. Use the explicit fixture test commands below when exercising behavior without production actions.

## Verification

Run the Node unit and integration tests:

```sh
npm test --prefix desktop
```

These do not open the desktop or connect to a production gateway. Some integration fixtures create temporary loopback servers. Tests that use a real installed GCB package still use fictional responses or mock model endpoints; they do not authorize live model calls. Installed-engine integration cases are skipped when GCB is absent. For the complete unit run, prefix the command with `OPENCLAW_PLUS_TEST_GCB=/absolute/path/to/gcb-venv/bin/gcb`.

Install GCB independently as described in the [usage guide](USAGE.md#connect-gcb). To run the complete native fixture suites, supply its absolute executable path:

```sh
OPENCLAW_PLUS_TEST_GCB=/absolute/path/to/gcb-venv/bin/gcb npm run test:native --prefix desktop
```

Native tests require Apple Silicon macOS, an active graphical session and `/opt/homebrew/bin/node`. They run serially with isolated app profiles and fake gateways; a running OpenClaw installation is not required. The GCB demonstration requires the installed executable. Its override is a development test seam, available only with an isolated test profile in an unpackaged app. Production selects GCB through the native file chooser.

Terminal tests use an in-memory echo connector, not a live shell. Voice tests use silent synthetic audio and mocked providers/permission prompts; they do not qualify physical microphones or real provider compatibility. Fixture coverage includes conversations, questions, activity, delegation, automations, approvals, permissions, terminal, voice, Models, profiling lifecycle, evidence disclosure and persistence. Native logs and captures are written into a new ignored `evidence/runs/` directory per run.

### Hosted CI

[Desktop checks](https://github.com/Leogy101/openclaw-plus/actions/workflows/ci.yml) runs on pull requests and pushes to `main`, using one standard Ubuntu 24.04 runner. It installs the npm lockfile without lifecycle scripts, checks JavaScript syntax, prepares the renderer and runs the complete unit/security suite with installed-GCB integration enabled. These checks are headless and platform-independent. This is plain JavaScript; there is no TypeScript typecheck.

Actions are pinned to commit SHAs, Node to 26.10.0, and the independent GCB 0.3.2a1 release wheel to its published SHA-256. Ubuntu's system Python 3.12 avoids relying on `LD_LIBRARY_PATH`, which the desktop intentionally removes from GCB subprocesses. The four installed-GCB cases use fictional responses or a temporary fake Ollama HTTP server. No OpenClaw installation, provider credentials, model weights or live inference are required.

CI has read-only repository permissions, does not retain checkout credentials, and uploads no profiles, screenshots or test artifacts. It does not run Electron, native GUI tests, packaging or release publication. Passing Linux CI does **not** qualify the native macOS application: the existing Apple Silicon graphical-session tests and packaged startup/recovery checks remain separate release checks. No self-hosted runner or GUI workaround is required by this workflow.

GCB's own Python, host-bridge and release tests belong to its independent checkout. Follow that repository's verification instructions; a desktop test pass does not replace them. Live profiling is a separate explicitly authorized activity, never part of these fixture commands.

The retained visual prototype is an optional historical baseline. From `desktop`:

```sh
npx playwright install chromium
npm run test:prototype
```

## Package and launch

```sh
npm run package --prefix desktop
```

For version **0.8.0-preview.6**, the output is:

```text
releases/0.8.0-preview.6/OpenClaw+-darwin-arm64/OpenClaw+.app
```

Open the application in Finder to launch the local build. Packaging does not install it. Repeating the command replaces the generated output for that version.

The packager includes runtime license notices, enables Electron security fuses and verifies an **ad-hoc signature**. It does not provide Developer ID signing or Apple notarization. There is no public installer or automatic update service. Packaging produces a local application directory; preparing a distributable ZIP, checksum and release entry is a separate review step. Build results are not claimed to be byte-identical across macOS or toolchain versions.

When a release supplies a macOS ZIP and `SHA256SUMS.txt`, check the ZIP against that checksum manifest, extract it with Finder and move the contained **OpenClaw+.app** to your Applications folder. Check that release's compatibility and signing status before opening. macOS may block downloaded ad-hoc builds.

The supplied artwork stays in `desktop/assets/openclaw-plus-logo.png`. `npm run build:icons --prefix desktop` regenerates its macOS icon using Apple's image tools without changing that source image.

## Integration boundaries

| Component | Responsibility |
| --- | --- |
| Electron renderer | Interface, with no Node access or direct gateway credentials |
| Main-process adapters | Fixed validated operations and exact native session/connection identities |
| Installed OpenClaw | Authentication, agent execution, conversation storage, approvals and permissions |
| Independently installed GCB | Research, immutable plans, grants, benchmark cases, scoring, evidence, bios and routing explanations |

`desktop/src/gcb-service.cjs` runs the selected GCB executable with fixed argument arrays, no shell and a restricted environment. `gcb-native.cjs` checks the current native model route. `gcb-openclaw.cjs` limits the optional host transport to completion/cancellation and pins its reviewed loopback endpoint; it contains no profiling logic. GCB's engine is neither vendored nor modified.

Profile evidence is read on demand through GCB's existing `evidence` command. The desktop resolves target, plan and database internally and projects bounded matching records; the renderer cannot provide filesystem paths or arbitrary arguments. No second result database is created for the disclosure.

Research declarations, observed fixture behavior, requested native settings and routing policy eligibility are distinct. Requested context/output values are not independently proven runtime or billing enforcement. Live routing and unsupported pre-inference enforcement remain unavailable.

See [SECURITY.md](../SECURITY.md) for the security boundary and reporting process, and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for packaged notices.
