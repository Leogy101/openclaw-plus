# Working on OpenClaw+

The original application code and documentation are available under the [MIT License](LICENSE). Keep contributions free of credentials, personal profiles, real conversations and private agent or project details. Use generic synthetic fixtures for examples and tests.

Use the setup commands in [README.md](README.md). Keep changes focused on an observable problem, and preserve OpenClaw as the runtime and source of truth.

## Source layout

- `desktop/src`: Electron main process, validated gateway operations and native boundaries.
- `desktop/ui`: renderer source; edit this directory rather than generated `desktop/renderer` files.
- `desktop/shared`: portable, pure presentation and activity models.
- `desktop/scripts`: UI preparation, icon conversion, packaging and test runners.
- `tests`: unit checks and isolated native fixtures. The retained `prototype` is a design reference, not the connected app.

## Verification

From `desktop`, run `npm test` for unit checks. For affected desktop behavior, run `npm run test:native` in an Apple Silicon macOS graphical session; it prepares the renderer and runs the fixture suites serially. Do not launch competing native test runs. Use `npm run package` when a change affects packaged resources or native boundaries.

Add focused regression coverage at the boundary that failed. Use mock or isolated fixtures for sending, approvals, configuration changes and terminal input. Tests must not depend on a contributor’s private gateway, transcripts or credentials.

No continuous-integration workflow or automated public release pipeline is configured in this repository. Record the local checks for each change; an uploaded source tree alone is not release qualification.

Describe the behavior changed and the checks actually run. Report an unrun check as unrun. Keep generated renderer output, application bundles, dependency folders, test evidence and local configuration out of commits. Review screenshots and excerpts before sharing; use synthetic examples for public reports.
