# M3 release readiness

OpenClaw+ `0.8.0-preview.1` adds GCB-backed model research, reviewed benchmark plans, explicit usage authorization, progress, partial capability bios, recorded evidence and explainable routing previews. GCB remains independently installed and owns the profiling engine and evidence store.

## Reviewed source

The release source contains the accepted M3 implementation and final UI correction. The application source under `desktop/src`, `desktop/shared` and `desktop/ui` is unchanged from the accepted correction. Unrelated unpublished development work is excluded. The release version is set consistently in the package and lockfile.

Collapsing navigation previously hid the sidebar but left a zero-width first grid track. Main content was auto-placed into that track. The corrected collapsed shell has a single flexible track. Long identifiers and descriptions wrap, and comparison tables have a focusable local scroll region.

Recorded responses appear only in a user-opened disclosure. A fixed, bounded read-only bridge reads GCB's existing public evidence command for the selected registered plan. Response, score, expected criterion, requested settings and usage are distinct; untrusted text is escaped and display-capped. Missing content is explicit, and no duplicate result store is created.

## Live evidence already obtained

A separately authorized local Ollama smoke used `qwen3.5:9b` and requested `think:false`, 4096 context tokens and a 128-token output ceiling. One inference completed without retries. `coding.guard` passed 1/1 with retained structured response `{"missing_guard":"empty_items"}`. Reported usage was 114 input / 8 output tokens; elapsed time was approximately 9.74 seconds.

The resulting partial bio and response survived workspace refresh and desktop restart. Seven checks remain pending. No additional real inference was performed during the final release review. This result does not establish broad capability, comparative reasoning performance, effective request-limit enforcement, peak memory or real cancellation behavior.

## Verification scope

See [verification record](M3_VERIFICATION.md) for exact results. Tests use isolated profiles, synthetic native catalogs, GCB's fictional backend and mocked local responses. They cover conversations, activity, automations, voice, terminal, permissions, approvals, registration, research, usage consent, progress, interruption, pause/resume, cancellation, evidence, routing previews and persistence.

Layout verification covers expanded/collapsed navigation, long content, narrow windows, light/dark themes, keyboard navigation and 150%/200% zoom. Very narrow windows require scrolling. Synthetic demonstration assets are reproducible with [the desktop capture workflow](docs/DEMO.md); they do not represent real model competence.

## Packaging and compatibility

The preview targets Apple Silicon macOS and a separately installed, supported local OpenClaw installation. The fixed installation paths and connection restrictions are documented in the [README](README.md). GCB and OpenClaw are not bundled. The local Ollama smoke path requires an already configured and accessible native model; other live adapter paths have offline integration coverage but no live qualification from this smoke.

The application is ad-hoc signed, not Developer ID signed or Apple notarized. No notarized public installer or automatic update channel is provided. Packaging retains Electron and xterm license notices. See [third-party notices](THIRD_PARTY_NOTICES.md), [security boundaries](SECURITY.md) and [draft release notes](RELEASE_NOTES_0.8.0-preview.1.md).

Routing recommendations remain previews and do not alter live agent assignments. Registration, profiling authorization and live routing are separate. Cancellation cannot prove provider termination; uncertain completions are not replayed. GCB retains allowlisted parsed structured responses, so arbitrary original text, formatting and hidden thinking may be unavailable. Local evidence is unencrypted and should be reviewed before sharing.

## Publication status

This is a prepared local release candidate. Its source, application archive, checksums and synthetic demo assets require final publication approval. No commit push, release tag or GitHub Release is created by the verification workflow.
