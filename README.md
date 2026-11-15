# OpenClaw+

<img src="desktop/assets/openclaw-plus-logo.png" alt="OpenClaw+ desktop app" width="320">

An independent macOS desktop workspace for an existing OpenClaw installation. OpenClaw remains the runtime and source of truth; OpenClaw+ provides a focused interface for conversations, agent activity and terminal work.

**OpenClaw+ is an independent, unofficial project, not the official OpenClaw application.** Version **0.7.7** includes a personal Models workspace for the native published catalog, local model references, and a handoff to OpenClaw provider setup. Qualification and routing remain unavailable.

## Features

- Conversations, retained history, existing delegated agent sessions and visible tool output.
- Activity and automation views that distinguish observed execution from reported status and incomplete telemetry.
- Message composition with supported attachments, model and reasoning controls, and retained asynchronous question cards.
- Read assistant reports aloud through OpenClaw’s configured speech provider.
- Dictate into a draft or talk with the selected agent through supported OpenClaw voice providers.
- Review and explicitly change the selected session’s native execution-permission mode.
- Approval review and configuration editing through OpenClaw’s own permission checks.
- A resizable terminal below or beside chat, with explicit sharing of selected output into a message draft.
- Models catalog with provider availability, reasoning metadata, local personal registration and native setup handoff. The provider menu includes packaged native onboarding choices as well as providers in the published catalog; selecting an unconfigured provider offers native setup without inventing model availability.
- Local light/dark themes, keyboard controls, native menus and an isolated renderer.

## Requirements and scope

The current target is **Apple Silicon macOS**. Building the desktop and running its unit tests require **Node.js 22.12 or newer**. Running the desktop and its native tests requires an active graphical macOS session.

Gateway integration has been exercised against **OpenClaw 2026.11.1**. Live use currently requires Node at `/opt/homebrew/bin/node` and OpenClaw at `/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs`. Alternative installation locations are not configurable in this release. The Node executable used for live connections must also satisfy the installed OpenClaw package’s requirements: the tested OpenClaw 2026.11.1 declares **Node 24.16–24.x or 26.1 and newer**. The desktop’s lower build-tool minimum is not sufficient for that runtime.

Before starting the app, configure and authenticate OpenClaw using its [official tools and documentation](https://docs.openclaw.ai/). The supported connection is a gateway running in **local** mode with a **loopback** bind, **token or password authentication**, and **TLS disabled**. The connector reads the default `~/.openclaw/openclaw.json` as JSON and uses its configured port and existing local authority. Named profiles, custom configuration paths and shell environment credential overrides are not selected or forwarded. OpenClaw+ does not install a gateway, recreate agents or copy gateway credentials into the renderer.

Remote gateway selection, Intel macOS and other operating systems are not currently supported. Project-record observation is unconfigured by default; the app does not search for private project files. Unavailable or ambiguous information remains explicitly unverified. This is not a complete replacement for every official OpenClaw interface. Keep the original interface available for unsupported administration and recovery operations.

## Install, build and test

From a checkout, enter the `desktop` directory:

```sh
cd desktop
npm ci
npm run setup:electron
npm run build:ui
npm test
```

The explicit setup step downloads the pinned Electron runtime using Electron’s own installer. This Electron package does not download its runtime automatically during `npm ci`. Packaging and native tests check for the runtime and explain the setup command if it is missing.

`npm test` runs the Node unit tests without opening the desktop or connecting to a gateway. The lockfile pins build and test dependencies; install and Electron setup require access to their upstream download services. The commands below describe how to verify your checkout; they are not a claim that every checkout or OpenClaw version has already passed.

Run the current native fixture suites, serially, in an active Apple Silicon macOS graphical session:

```sh
npm run test:native
```

These suites require `/opt/homebrew/bin/node` but use isolated app profiles and a fake gateway; a running OpenClaw installation is not required. Terminal tests use an in-memory echo connector: no shell commands execute. Voice tests replace the system permission prompt and physical microphone with silent synthetic audio and an in-memory provider. They do not establish real microphone or provider compatibility. Run the suites serially so their windows do not compete for focus. Logs, screenshots and fixture profiles go into a new directory under `evidence/runs/` on every run and are excluded from Git.

The retained visual prototype is an optional historical baseline. Install Playwright’s managed Chromium before running it:

```sh
npx playwright install chromium
npm run test:prototype
```

To open the development application against your configured local OpenClaw installation:

```sh
npm start
```

To create a local application package:

```sh
npm run package
```

Packaging creates `releases/<version>/OpenClaw+-darwin-arm64/OpenClaw+.app`, includes runtime license notices, enables Electron security fuses and verifies an ad-hoc signature. Repeating the command replaces the generated package for that version. It does not install the result, configure updates, provide Developer ID signing or notarize a public release. These are repeatable build steps, not a guarantee of byte-identical bundles across macOS or toolchain versions. There is no signed public installer or automatic update channel in this repository.

The supplied logo is preserved in `desktop/assets/openclaw-plus-logo.png`. The checked-in macOS icon can be regenerated with `npm run build:icons` on macOS; this only resizes and converts the intact image with Apple’s image tools. The renderer uses a text wordmark and does not load the logo.

## Everyday use

Choose an existing conversation from **Conversations**, or browse an agent’s conversations from **Agents**. Send messages with the composer. Unanswered asynchronous questions stay above the message box, with a compact reference in the transcript. **Send answer** submits selected or typed answers directly, preserving the separate message draft and attachments. Saved replies from another OpenClaw client also remove answered questions from this dock when their native reply target or uniquely matching quoted answer is verified. An unconfirmed send offers an explicit same-request retry; it is not a confirmed answer receipt. Model and reasoning choices appear only when the gateway supplies them. Unsent message drafts, selected attachments and question-answer selections are retained in memory while the app is running, not saved for restoration after quitting. OpenClaw retains accepted conversations; the app separately saves its appearance preferences and Models registry.

Right-click the message box for the native Undo, Redo, Cut, Copy, Paste and Select All menu. Normal keyboard editing shortcuts remain available. The conversation title shares a compact row with its connection and agent. Consecutive tool-only messages are collapsed into **Tool activity** sections between reports; expand a section to inspect each original call, output or reasoning detail. Reports, questions and attachments remain visible, and expanded details are preserved during refresh.

Question detection uses the latest bounded history and earlier messages you explicitly load. Observed pending questions remain available while that conversation is open, even as newer messages arrive. The app does not scan the entire transcript automatically; after reopening a long conversation, use **Load earlier messages** to review questions outside the current history window. Refreshing new questions while browsing earlier history preserves your place.

Message submission, its required session checks and the first refresh after acceptance take priority over queued background reads. Background conversation refreshes keep Send available after the exact conversation has loaded; known access or session changes block it until a verified refresh. For a known conversation branch, the fresh session check and send share one short-lived OpenClaw client startup. Requests already running finish normally, and the app keeps the same two-request concurrency limit. Gateway processing and connection time still affect confirmation; **Sending** changes to accepted only after OpenClaw returns a receipt. A checklist refresh invalidated by a send retries once without flashing an error; persistent failures remain visible.

Choose **Read aloud** beside **Copy** on an assistant report to hear its prose. The same button stops playback, including while audio is being prepared. Long reports play in sequential chunks; fenced code, hidden reasoning and tool output are excluded. Reading uses OpenClaw’s configured speech provider, which receives the report text; configure it in original OpenClaw if unavailable. The app does not change providers or credentials and does not fall back to browser voices. Stopping discards late audio and prevents later chunks, but cannot undo a speech request already sent to the provider.

Choose **Voice options** beside the composer to see the modes supported by your configured OpenClaw providers. **Dictate** requests microphone access and records text for the selected conversation. **Finish dictation** appends final recognized words to that conversation’s existing draft; review and send them yourself. **Cancel** discards unfinished dictation. **Talk to …** starts a live voice conversation with that agent, without sending your typed draft. It can start native agent work under the session’s existing permissions. **Stop talking** ends the voice session and requests native cancellation of its active work; cancellation is not a rollback of completed actions. Leaving the conversation, hiding the window or disconnecting stops local capture and detaches the viewer. Voice availability depends on the installed OpenClaw version and configured provider; the app does not enable providers, change credentials or invent a browser fallback. Audio leaves the app only through the selected OpenClaw voice session after you explicitly start capture.

To follow gateway-managed delegation, open **Work** and click a row under **Delegated sessions**. The app checks the parent and child session identities before opening that exact existing child conversation; the Work panel retains its source context. If an identity is missing or changed, refresh the session list instead of opening an unverified replacement. Use **Back to …** to return to the parent conversation and its draft. This navigation does not spawn another agent or start another task. OpenClaw continues to own delegation, execution and permissions.

**Delegation coverage:** this list contains child conversations exposed by OpenClaw's supported session interface. In the qualified OpenClaw version, provider-internal Codex helpers managed through tools such as `followup_task` and `list_agents` are separate provider threads, not automatically gateway child sessions. When exact native call/result identifiers and a successful dispatch acknowledgement are available in the loaded history, **Helper tasks** shows those recorded dispatches. **View dispatch record** opens its correlated dispatch receipt in the parent conversation; it does not attach to a helper or open a fabricated child session. OpenClaw currently does not expose an independently openable session or live status for these helpers through this interface. Its separate native session catalog excludes native subagent sources, and the dispatch acknowledgement does not supply an authoritative thread identity. Reports, task names or dispatch receipts are not proof that a helper is still working. An empty delegated-session list does not prove that no provider-internal work is running.

**Activity** shows returned active sessions; **Automations** shows existing schedules and execution history. **Approvals** presents supported pending decisions for review. Advanced configuration is under **Settings**; saving it can restart the gateway, as the review dialog explains. Workspace administration, integrations, devices and recovery remain available through **Open original OpenClaw**.

If the app cannot connect, check the local gateway and authentication in the original OpenClaw interface, then use **Reconnect**. A session identity conflict requires selecting the refreshed conversation again. An unconfirmed write is not a confirmed failure: review the current conversation or settings before deciding whether to retry.

## Personal Models workspace

Open **Models** in the sidebar or press **⌘7**. The app reads the gateway’s prepared, policy-filtered catalog through the public Gateway client. It checks advertised capabilities instead of requiring an exact OpenClaw version. This global catalog is not permission to use a model in any particular session. Availability is a native declaration; authentication and inference are not independently tested.

**All providers** also includes setup choices declared by the installed OpenClaw package, so providers can be browsed before they have published models. A provider without catalog entries shows **Open provider setup** instead of another provider’s model details. Choices are grouped by native provider IDs; they do not imply connection, authentication or qualification. Installed metadata is reread on explicit refresh and cached briefly between passive refreshes. **About this provider list** describes source and coverage; missing or changed metadata is shown as incomplete/unavailable, while catalog providers remain accessible.

**Register model** reviews and saves the exact provider/model and advertised reasoning preference as a personal reference. It changes only this app’s private registry, not OpenClaw provider settings, credentials, agents or model assignments. Registration, qualification and owner admission are separate. In this milestone, Checks and Personal routing explain their unavailable states; there is no evaluation or routing API to activate.

Use **Open provider setup** to open the supported setup page in the original local OpenClaw interface. Signing in, adding a key, configuring a provider and discovering additional models remain explicit native actions there. Return and choose **Refresh snapshot** afterward. Refresh rereads prepared inventory and packaged provider metadata: it does not request provider discovery, an authentication status refresh, a model probe or a benchmark. Native handling can still perform its normal login-state bookkeeping; this is not a promise that the gateway itself makes no incidental writes.

The registry is owner-only JSON in the app’s `ModelManager` support subdirectory, with atomic saves and a previous valid snapshot. Restarted or disconnected inventory is marked unverified until refreshed. Corrupt or externally changed storage becomes read-only; no automatic overwriting or replay occurs. No credentials or qualification/admission records are stored in this M2 registry. Model metadata/state functions are independent of Electron; no shared service or database was added.

The native Models tests use isolated profiles and synthetic catalogs through the actual desktop main process, security bridge and renderer. They test local registration, denied native mutations, stale data, restart, and keyboard/window behavior. Their synthetic state tests do not qualify a real provider or execution environment.

## Permissions and terminal sharing

The renderer has no Node access or direct gateway connection. Main-process adapters validate fixed operations and exact session identities. Gateway authentication, approvals and policy enforcement remain with OpenClaw. Sending messages, resolving approvals, saving settings and starting a terminal are explicit user actions.

The shield beside Attach opens **Execution permissions** for the selected conversation. Review a mode and choose **Apply permissions** to change it; merely opening the dialog does not write. **Default** inherits configuration and does not guarantee restricted access. **Full access** requires a separate acknowledgement and native administrator authority. These are OpenClaw’s session policy modes, not a new sandbox. Independent runtime restrictions still apply. A pending or unconfirmed change requires an explicit refresh before another change is attempted.

Opening the Terminal pane does not start a shell. **Start terminal** creates a gateway-hosted shell for the selected conversation. Commands run with the gateway’s existing terminal authority; the terminal is not an additional sandbox or a per-command approval screen. **Disconnect terminal** detaches this viewer; OpenClaw owns the shell’s lifecycle.

**Add selection to message** copies selected terminal output into the owning conversation’s draft and preserves existing draft text and attachments. It does not send the message. Only an explicit Send shares that prepared message. Native agent terminal access remains governed by OpenClaw’s existing permissions.

The response indicator reports the selected conversation’s active response, observed elapsed time, and output tokens when OpenClaw supplies them. An active response is separate from verified engineering activity; answering or reporting does not prove implementation work. Missing usage data is shown as unavailable, and stale or disconnected readings stop presenting themselves as live.

Activity views are bounded observations, not proof of overall project completion or authority to proceed. Disconnected, stale, ambiguous and unavailable information stays distinguishable from idle or completed work.

## Source and licensing

Application source is in `desktop/src`, `desktop/ui` and `desktop/shared`; isolated tests are in `tests`. Generated renderer files, packages, local profiles and diagnostic evidence are excluded from the repository. The source logo and reproducible icon derivatives are checked in. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for security boundaries and safe reporting.

The original application code and documentation are licensed under the [MIT License](LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The project name and artwork are excluded from the code license; no trademark rights are granted. Demo agents, conversations and project examples are synthetic and do not describe a bundled installation.
