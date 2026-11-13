# Security boundaries

OpenClaw+ is an unofficial local frontend. OpenClaw remains responsible for gateway authentication, permissions, approvals, agent execution and terminal lifecycle. The app is not an additional sandbox for a gateway-hosted shell.

The current adapter accepts only the configured local loopback gateway over local HTTP/WebSocket transport. The supported authentication modes are token and password; TLS and remote endpoints are not supported. The renderer has no Node access or direct gateway connection; native operations pass through validated main-process handlers. Message sends, approval decisions, configuration saves and terminal starts require explicit user actions. Gateway policy still applies to those actions.

Terminal output is untrusted content. Selecting **Add selection to message** prepares a draft; only **Send** shares it with the selected conversation. Configuration changes may restart the gateway. An unconfirmed operation must be reviewed before retrying.

Execution permission changes bind to the selected physical session and the reviewed permission mode, plus the lifecycle revision when OpenClaw supplies one. Full Access requires a separate acknowledgement and native administrator authorization; Default inherits configured policy and does not guarantee restricted access. A submitted change with an uncertain outcome requires a fresh read before another attempt.

Read Aloud sends selected report prose to the gateway’s configured speech provider only after an explicit click. Dictate and Talk request macOS microphone access only after choosing a mode. Audio passes through the configured local gateway connection; gateway credentials remain outside the renderer. Dictation prepares a draft. Live Talk can initiate native agent work under existing OpenClaw policy and approvals. Audio is bounded in memory, never automatically replayed after a disconnect, and not saved in an app recording database. Provider and OpenClaw retention policies still apply.

Only the trusted main application frame can request microphone capture during a short explicit capture grant. Camera and other web permissions remain denied. The renderer can load only bundled resources and validated local playback audio, with no direct provider or external network access. Leaving the owning conversation, hiding or minimizing the app, disconnecting, or quitting stops microphone capture; closing only the Voice options dialog does not end an active call. The visible Stop/Cancel controls remain available. Supported live-session detach preserves already accepted agent work, while an explicit Stop requests the native stop behavior.

## Models and local state

The Models workspace reads prepared catalog metadata and installed provider setup declarations. It has no discovery, authentication-refresh, benchmark, admission or task-routing operation. Native catalog handling can still perform OpenClaw’s normal login-state bookkeeping. A displayed provider or model is not proof of successful authentication, inference or permission to use it in a session. Opening provider setup hands off to the original local OpenClaw interface; any changes there are separate native actions.

Personal model references and the last sanitized catalog snapshot are stored as owner-only JSON in the app’s `ModelManager` support subdirectory, with a previous snapshot for recovery. This data is not encrypted and may reveal model/provider choices to processes running as the same user. The registry contains no gateway credentials or qualification/admission records. Corrupt or externally changed storage becomes read-only rather than being silently replaced. Unsent drafts and attachment selections are held in memory. Do not share app profiles or diagnostic evidence without reviewing their contents.

## Reporting a concern

Do not put credentials, configuration dumps, private conversations or sensitive terminal output in a public issue. Use synthetic data and the smallest reproduction that demonstrates the problem.

If the repository offers GitHub private vulnerability reporting, use that channel for security-sensitive details. Otherwise, ask the maintainer for a private reporting channel without disclosing the sensitive details publicly. No dedicated security contact or response-time commitment is established by this document.

Local packages are ad-hoc signed, not Developer ID signed or notarized. Automatic updates and remote gateway support are not provided by this release.
