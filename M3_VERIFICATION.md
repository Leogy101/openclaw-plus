# M3 verification record

Final release qualification runs from an isolated source tree containing the accepted M3 implementation and UI correction. Unrelated unpublished work is excluded. All real-model evidence comes from the previously authorized one-attempt smoke; verification uses synthetic fixtures and mocked responses only.

## Results

| Check | Result |
| --- | --- |
| Clean desktop unit/security/integration suite | 417 passed, no failures or skips |
| Complete serial native desktop suite | 20/20 suites passed in one run, plus UI preparation |
| GCB Python suite | 247 passed |
| GCB OpenClaw host-bridge suite | 151 passed |
| GCB public release/export suite | 8 passed |
| Independent GCB dependency check | Passed; no broken requirements |
| Installed GCB engine/fixture files versus source | All 25 matched |
| Fresh application packaging and source provenance | Two identical bundles; all runtime sources, helpers, vendor assets and notices match |
| Distribution archive | Extraction matches all 272 files and 14 symlinks; strict deep signature verification passed |
| Packaged desktop walkthrough | Correct version, startup/shutdown, Models, retained response, refresh and restart recovery passed |
| Dependency advisory check | npm audit: zero reported vulnerabilities |
| Synthetic portfolio demonstration | Eight native UI captures; hashes and privacy review passed |

The complete desktop suite exercises chat/composer, activity, delegation, automations, permissions/approvals, terminal, voice/read-aloud, questions, run state, transcript layout and Models registration. GCB integration tests cover research without inference, exact consent, stale/invalid metadata, disconnected providers, private storage, endpoint binding, progress, pause/resume, cancellation, interruption/restart, unknown completion, partial bios, reasoning comparisons and preview-only routing. New evidence tests validate scope, field filtering, payload limits and missing responses. Native layout fixtures exercise wrapping, keyboard navigation, disclosure state and 100%/150%/200% zoom.

A restricted independent test process could not bind mock loopback HTTP ports in nine GCB Python error records. The complete Python suite then passed from the main test session with those fixture ports available. No real model endpoint was called. Previous native context-menu focus issues are tested with the exact fixture WebContents and verified native menu roles, without operating on another application's first responder.

## Packaging and publication privacy

The final macOS arm64 bundles report `0.8.0-preview.1`. Two fresh builds on the same toolchain produced identical bytes for all 272 files and identical 14 symlink targets. This is a local reproducibility observation, not a cross-platform guarantee. Runtime source remains identical to the accepted M3 UI implementation; the release preparation changes version metadata, documentation, demo capture and packaged notices.

The existing packager now includes the complete pinned Mantle and ReactiveObjC licenses omitted from Electron’s combined notices. All eight application/runtime notice files, the project icon, security fuses, ASAR integrity and strict deep ad-hoc signature verification passed. The extracted ZIP was launched and closed successfully. It recovered the frozen one-attempt Qwen partial bio without new inference.

The public source and package exclude private review details and unrelated unpublished work. A sanitized publication commit preserves the accepted implementation while retaining the original local review history on local branches. The public demo contains only reviewed synthetic UI screenshots and a sanitized manifest. Private profiles and raw operational evidence remain local. No tag, push or GitHub Release is created by this qualification.

## GCB independence

GCB reference: `Leogy101/governed-capability-broker@cd3b4cb8f397e6e382bd64e7884ab27e451df176`, independently installed package `0.3.2a1`. Its engine source is unchanged. No engine, benchmark cases, scorers or alternate ranking algorithms are vendored into OpenClaw+. GCB retains its own CLI, Python API, package and evidence store.

## Evidence and reproduction

Run desktop tests using the commands in the README and GCB integration guide. Native tests require an active graphical Apple Silicon macOS session and run serially with isolated profiles. Logs and private fixture profiles remain in ignored `evidence/` directories. Share only reviewed synthetic images and their sanitized demo manifest, as described in [the demo instructions](docs/DEMO.md).

See [readiness and limitations](M3_READINESS_REVIEW.md) and [draft release notes](RELEASE_NOTES_0.8.0-preview.1.md). Local verification does not authorize publication or further real-model usage.
