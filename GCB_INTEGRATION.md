# GCB model profiling (M3)

OpenClaw+ provides the Models interface. [GCB](https://github.com/Leogy101/governed-capability-broker) owns research, benchmark cases, scoring, immutable usage plans, durable grants, SQLite evidence, capability bios and routing intelligence. No benchmark engine or provider credential store is added to the desktop.

## Offline demonstration

1. Install GCB independently in a Python 3.11+ virtual environment following its repository instructions. Keep that environment in a permanent location. OpenClaw+ does not download or install packages automatically.
2. Start the desktop with `npm start --prefix desktop`. Open **Models → Checks → Connect GCB** and choose that environment's `bin/gcb` executable. This is trusted local software, so choose your reviewed installation.
3. Choose **Forge** or **Scribe**, then **Research capabilities**. These are GCB's bundled fictional models with deterministic mock responses and no provider access.
4. Choose whether to compare reasoning configurations, then **Review benchmark**. Inspect the exact GCB request limit, checks, configurations, time budget and output bound. The consent checkbox starts unchecked. Registration alone grants no usage authority.
5. Approve the offline scope and start. Progress and partial bios update while GCB runs. **Pause after this check** retains completed cells. Resume through a fresh usage review; the same immutable plan and cumulative limits remain in force.
6. Read the capability bio and reasoning comparison. In **Personal routing**, choose **Preview recommendations** to see GCB's role-specific reasons. These synthetic results never represent real model competence.

Cancelling requests a durable GCB stop; it cannot retract a dispatched request or prove provider termination. Unknown completion is shown explicitly and is never automatically replayed. Restart reads saved evidence and does not restart benchmarks.

Open **Recorded response** beneath the bio to inspect retained per-check output, score, requested native settings and reported usage. This disclosure reads GCB's existing `evidence <plan-id>` public command only when opened, through the same trusted desktop bridge. The desktop resolves the plan/database internally and keeps no additional result store. Expected scoring criteria are shown separately. GCB currently retains only allowlisted parsed structured responses; arbitrary output, hidden thinking and original response formatting are unavailable, and are never reconstructed from a score. Display is escaped and capped at 8,192 characters; oversized or mismatched bridge payloads fail closed. Switching targets or changing evidence invalidates the open response view.

## Existing native OpenClaw models

### Local Ollama smoke test

Select an existing local Ollama model in **Catalog → Research and benchmark → Prepare local smoke test**. The desktop checks the current OpenClaw catalog's availability and selection policy and reads the already configured plain loopback Ollama endpoint. It accepts no endpoint or credentials from the renderer and does not create a provider or change an agent. Local registration remains an independent personal reference.

Choose **Research capabilities**, then **Review benchmark**. GCB's existing Ollama adapter reads the exact installed artifact digest, capabilities and native thinking values. The local smoke preset explicitly selects GCB's researched `think:false` configuration with `num_ctx:4096` and `num_predict:128`. The review shows the exact native settings, one cumulative inference attempt, a 45-second call deadline and a 60-second runner budget. It requires a fresh, unchecked local-compute consent; research and planning run no inference. No host bridge, account change, provider installation or Gateway restart is required.

GCB prepares its existing eight-cell baseline suite, but this smoke grant permits only the first attempt (`coding.guard`). The desktop stops at that limit and labels the resulting bio **partial**; it does not complete the other seven checks or establish broad capability or routing suitability. Reasoning contrasts are disabled for this preset. A larger real profile needs a separately reviewed future scope.

GCB calls the configured local Ollama API directly, after native OpenClaw availability checks. It revalidates the installed digest and metadata before inference. The test can cold-load the existing model and leave it resident under Ollama's defaults. Context/output values are requested runtime limits, not independently measured memory or effective-setting guarantees. Cancellation retains uncertain in-flight completion and prevents replay; it cannot promise immediate server termination. Local billing provenance remains unknown in the bio.

Catalog availability, local registration, profiling authorization and live routing remain separate. Provider setup and authentication stay in OpenClaw. The desktop continues using its existing configured local loopback connection and native permission boundaries.

GCB's current public host adapter supports a narrowly configured OpenClaw/Codex subscription route. It requires the separately installed, explicitly configured [GCB host bridge](https://github.com/Leogy101/governed-capability-broker/tree/main/integrations/openclaw-host). The desktop does not install or activate this plugin, modify its allowlists, restart the Gateway, change agent assignments or switch accounts. Other catalog providers may be registered but cannot be profiled through this adapter.

Use **Add OpenClaw target** to import a reviewed nonsecret GCB host snapshot JSON. The snapshot identifies the exact agent, model, native reasoning choices, context declaration and installed host/runtime versions. It must use GCB's documented schema, not an OpenClaw configuration or credentials file. The desktop validates current catalog availability, selectable policy, reasoning and context metadata and calls the bridge's metadata-only `gcb.profile.preflight` through existing native authentication. A stale, disconnected, denied or unsupported target remains unavailable.

Research is based on the reviewed snapshot and GCB's cited adapter contract. It is not autonomous web discovery or a claim that provider declarations were independently measured. Profiling measures the supported fixture behaviors. The live usage review separately requires acceptance of the host runtime and subscription/provider usage. The host may ignore output hints, perform hidden provider requests and omit billing provenance. Unknown cost is never presented as zero or as a guaranteed spending cap. Effective reasoning effort is unknown unless the native runtime reports it.

## Implementation boundary

- `desktop/src/gcb-service.cjs` supervises a selected installed GCB executable with fixed argument arrays and a restricted environment. Only explicit profile operations cross the existing trusted main-frame IPC bridge.
- `desktop/src/gcb-native.cjs` checks the current passive catalog and the exact subscription bridge scope before live work. No inference command was added to the desktop's native read lane.
- `desktop/src/gcb-openclaw.cjs` is a fixed native CLI transport for GCB's existing adapter. It permits only profiling completion/cancellation and adds OpenClaw's supported `--expect-url` check for the reviewed loopback endpoint. It resolves no credentials and implements no benchmarking logic.
- `desktop/ui/profile-view.mjs` renders GCB research, plans, status, bios and recommendations. It does not score or rank models.
- The app's private `GCB` support directory holds connection/index records and separate offline, local Ollama and OpenClaw-host GCB databases. Registration remains in `ModelManager/registry.json`. No credentials, chat history or project files enter benchmark inputs.
- GCB remains independently installable and usable from its CLI, Python API and optional integrations. The desktop does not vendor or modify its engine.

## Verification

The desktop's existing unit and native suites still cover chat, terminal, activity, voice, automations, approvals, permissions and registration. M3 adds native readiness tests, service lifecycle/security tests and an Electron demonstration using the real installed GCB package with its fictional backend.

```sh
npm test --prefix desktop
OPENCLAW_PLUS_TEST_GCB=/absolute/path/to/gcb-venv/bin/gcb npm run test:native --prefix desktop
```

The executable override is a development test seam, honored only with an isolated test profile in an unpackaged app. Production uses the native chooser. Native suites run serially on Apple Silicon macOS. Test profiles and screenshots are written under ignored `evidence/runs/` directories. GCB's own Python and host-bridge tests must also pass from its separate checkout.

One separately authorized local Ollama smoke has passed: `qwen3.5:9b`, requested `think:false`, one attempt without retries, `coding.guard` 1/1, retained response `{"missing_guard":"empty_items"}`, reported usage 114 input / 8 output tokens, and 9.74 seconds. Its partial bio persisted. This does not establish broader capability, effective-setting enforcement or real cancellation behavior. The OpenClaw/Codex host path has offline integration coverage but has not received this live validation. Every new live scope requires its own displayed usage review and authorization.

## Release recommendation

Version `0.8.0-preview.1` is prepared from isolated reviewed release source. It includes offline onboarding, bios, routing previews and the bounded local Ollama smoke path with explicit native prerequisites. See [release readiness](M3_READINESS_REVIEW.md) for verification and limitations. Live routing remains unavailable. Other live adapter paths require separately authorized bounded tests. A prepared local candidate is not a published release.
