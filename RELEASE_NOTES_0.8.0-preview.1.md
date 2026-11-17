# OpenClaw+ 0.8.0-preview.1

Preview release notes for Apple Silicon macOS. This document describes the candidate's scope; it is not an announcement that a release has been published.

## Models profiling through GCB

- Connect a separately installed GCB executable and try its fictional Forge/Scribe targets offline.
- Research supported model identities and reasoning configurations, review exact benchmark scope and explicitly authorize usage.
- Follow progress and partial bios, pause after a check, cancel and freshly review safely resumable work without replaying unknown completion.
- Compare supported configurations and inspect capability coverage, usage, latency and uncertainty.
- Open **Recorded response** for retained structured output and separate scoring criteria; missing output stays explicit.
- Preview role-specific recommendation reasons without activating routing or changing assignments.
- Prepare a one-attempt local Ollama smoke for an existing native catalog model. The optional OpenClaw/Codex host route remains dependent on its separately configured GCB bridge and usage authorization.

Models layouts now accommodate collapsed navigation, narrow windows, long identifiers and zoom. Response details wrap within a bounded keyboard-accessible view; wide comparison tables have their own scroll region.

Existing conversations, tool activity, asynchronous questions, attachments, voice/read-aloud, terminal, activity, automations, approvals and session-permission controls remain part of the workspace.

## Verified scope and limitations

The real desktop model validation is a local Ollama smoke: `qwen3.5:9b`, requested `think:false`, one `coding.guard` attempt passed, with 114 reported input tokens, 8 output tokens and approximately 9.74 seconds. Seven baseline checks remained pending. This is partial evidence, not broad capability qualification, a reasoning comparison or a recommendation to assign the model to an agent.

The local preset requests context 4096 and output 128, permits one cumulative attempt, and has 45-second call/60-second runner budgets. These are requested limits, not independent proof of effective native settings, memory limits or immediate cancellation. GCB's current evidence contract retains only allowlisted parsed structured responses, not arbitrary output, original formatting or hidden thinking.

Offline and mocked integration tests cover the supported workflows. The optional host route has not been live-validated through this desktop release. Unknown usage and billing remain unknown. Live routing and unsupported pre-inference enforcement remain unavailable.

## Compatibility and distribution

Requires Apple Silicon macOS and the supported local OpenClaw installation. Integration was exercised with OpenClaw **2026.11.1** and GCB **0.3.2a1**; the local smoke used Ollama **0.40.15**. Node/OpenClaw paths are currently fixed, the default OpenClaw JSON configuration is required, and remote gateways or named profiles are unsupported. See [requirements](README.md#before-you-start).

The application package is ad-hoc signed, not Developer ID signed or notarized. There is no installer or automatic update channel. [Build locally](docs/BUILDING.md) or follow the instructions of a future reviewed release artifact; these notes do not claim a public ZIP exists.

OpenClaw and GCB remain independently installed. The app does not install providers, pull model weights, modify agent assignments or restart the gateway as part of profiling. Preserve app-owned profile evidence when changing versions; older previews may not understand newer target types.

See the [usage guide](docs/USAGE.md) for onboarding, consent, response details and recovery.
