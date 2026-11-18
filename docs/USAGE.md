# Using OpenClaw+

OpenClaw+ connects to an existing OpenClaw installation. Before launching, check the [supported connection requirements](../README.md#before-you-start). Use **Open original OpenClaw** for provider setup, unsupported administration and recovery.

## Conversations and activity

Choose an existing conversation in **Conversations**, or browse one from **Agents**. To start a blank chat, choose **New Conversation** or press **⌘N**, select an agent and choose **Create**. OpenClaw stores the new conversation and waits for your first message.

Compose a message, add supported attachments and use the model or reasoning choices supplied by the gateway. The **Context** meter beside those pickers shows reported context usage. Hover over it for token counts and the applicable context window or last-run prompt budget. A tilde marks an approximate reading. Unsent drafts, attachments and question selections stay in memory while the app runs and are lost when it quits. OpenClaw retains accepted messages.

Type `/` at the start of a draft to see OpenClaw's available commands, and keep typing to filter the list. Click a command or use the arrow keys and **Enter** or **Tab** to insert it. **Esc** closes the list, and **Send** submits the command under the conversation's existing permissions.

When OpenClaw confirms an active response and the composer is empty, the primary button becomes **Stop**. Choose it to review the stop request for that response. Typing a follow-up or attaching a file brings back **Send** so you can submit it while work is active. Clearing the draft brings back Stop while the response is still active.

Unanswered asynchronous questions appear above the composer. **Send answer** submits the selected or typed answers while preserving the separate draft and attachments. Confirmed answers from another OpenClaw client can clear their matching questions. An unconfirmed submission is not a delivery receipt; review the current conversation before using its explicit retry action.

Use **Load earlier messages** to inspect older history. Question detection covers loaded history rather than scanning an entire conversation automatically. Consecutive tool-only messages collapse into **Tool activity** sections; expand one to inspect the original details. Right-click the message box for native editing commands.

**Work → Delegated sessions** opens existing child conversations after their identities are verified. **Back to …** returns to the parent and its draft. **Helper tasks**, when available, shows correlated provider dispatch records in the parent transcript; it does not provide an independently openable helper session or prove that a helper is still running. An empty child-session list is not proof that no provider-internal work exists.

**Activity** shows returned active sessions. **Automations** shows existing schedules and execution history. Missing, stale or ambiguous telemetry remains unverified. A response timer or token count describes an observed response, not proof that engineering work was completed.

## Office

Open **Office** in the sidebar or press **⌘8**. The pixel art floor plan gives each returned agent a desk and shows observed active turns as work at the desk. Confirmed delegations and recorded agent messages move a character between offices. When OpenClaw records a successful final reply for a direct user turn from the primary agent, that agent visits **Your office**. For the standard `main` agent, this is Tom if that is his display name.

The display checks recent sessions while the page is visible. The activity strip names the latest observed visit, and the roster provides a text equivalent of the desk states. OpenClaw may omit activity or handoff metadata from the sampled sessions. Final replies represent a recorded response to you. For project status and the reply text, use the original conversation.

## Voice and read-aloud

Choose **Read aloud** beside an assistant report to use OpenClaw's configured speech provider. The same control stops playback. Reports play in chunks; fenced code, hidden reasoning and tool output are excluded. Stopping prevents later chunks and discards late audio, but cannot undo a speech request already sent to the provider.

Open **Voice options** beside the composer:

- **Dictate** requests microphone access. **Finish dictation** adds recognized text to the owning conversation's draft for you to review and send. **Cancel** discards unfinished dictation.
- **Talk to …** starts a voice conversation with the selected agent without sending the typed draft. It can start native agent work under existing session permissions. **Stop talking** requests cancellation of active native work; completed actions are not rolled back.

Leaving the conversation, hiding the window or disconnecting stops local capture and detaches the viewer. Voice requires a compatible installed OpenClaw version and configured provider. Audio is sent through that provider after you explicitly start capture. OpenClaw+ does not enable providers, replace credentials or fall back to browser voices. Read-aloud sends report text to the configured speech provider.

## Terminal, permissions and approvals

Opening the Terminal pane does not start a shell. Choose **Start terminal** to open a gateway-hosted shell for the selected conversation. It runs with the gateway's existing terminal authority; it is not an additional sandbox or per-command approval screen. **Disconnect terminal** detaches the viewer; OpenClaw owns the shell's lifecycle.

Select terminal output and choose **Add selection to message** to append it to that conversation's draft. Existing text and attachments are preserved. Only an explicit Send shares the draft.

The shield beside Attach opens **Execution permissions**. Review a mode, then choose **Apply permissions**. **Default** inherits configuration and does not guarantee restricted access. **Full access** requires a separate acknowledgement and native administrator authority. OpenClaw's independent runtime restrictions still apply. A pending or unconfirmed change needs a refresh before another change.

**Approvals** presents supported pending native decisions. **Settings** exposes advanced configuration with an explicit review; saving some changes can restart the gateway. Model registration, research and profiling do not authorize such a restart.

## Models and capability profiles

Open **Models** in the sidebar or press **⌘7**. The catalog comes from OpenClaw's prepared, policy-filtered inventory. **Available** is a native declaration, not an independent authentication or inference test, and does not grant permission to use a model in every conversation.

The provider menu also includes setup choices from the installed OpenClaw package. **Open provider setup** opens the supported native setup page. After configuring a provider there, return and choose **Refresh snapshot**. Refresh reads the prepared inventory; it does not initiate model discovery, a benchmark or a probe.

**Register model** saves the exact model reference and advertised reasoning preference in this app's personal registry. It does not change providers, credentials, agents or assignments. Registration is optional for the separate profiling workflow.

### Connect GCB

[Governed Capability Broker](https://github.com/Leogy101/governed-capability-broker) provides research, benchmark cases, execution, scoring, bios and routing intelligence. The desktop provides its interface; it does not bundle or install another benchmark engine.

The integration has been exercised with **GCB 0.3.2a1**. Install it independently using Python **3.11 or newer** and the GCB repository's instructions. For a reviewed GCB source checkout, the upstream installation pattern is:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install .
.venv/bin/gcb doctor
```

Run these commands in the GCB checkout, not in OpenClaw+. Installation may download Python build tooling; GCB has no Python runtime dependencies. Keep the environment at a stable location. Then choose **Models → Checks → Connect GCB** and select its `.venv/bin/gcb`. This executable is trusted local software: select the installation you reviewed.

GCB also works on its own from its CLI or Python API. OpenClaw+ does not require a new server, credential store or cloud service.

### Research, review and run

1. Select a supported target. **Forge** and **Scribe** are bundled fictional GCB targets for offline practice; their scores, usage and latency are synthetic.
2. Choose **Research capabilities**. GCB identifies the model and supported native reasoning settings using adapter metadata and cited contracts. Research and planning perform no inference. Research is not autonomous web discovery or independent measurement of every declaration.
3. Choose **Review benchmark**. Inspect the exact configurations, checks, request allowance, output request, deadlines and known or unknown cost. Reasoning contrasts are available where the target and preset support them.
4. Check the usage consent and start. The checkbox begins unchecked. Native OpenClaw host runs require separate consent to the host runtime as well as possible provider or subscription usage. Registration alone authorizes no calls.
5. Follow progress and the partial bio. **Pause after this check** waits for the current check. Cancellation requests a durable stop but cannot retract a dispatched request or prove the provider has stopped.
6. Resume only when the interface offers it, through a fresh usage review. Completed cells and the same plan's cumulative limits are retained. Unknown completion is never automatically replayed. Restarting the desktop restores evidence without restarting a benchmark.

The bio separates observed checks, missing evidence, strengths, weaknesses, latency and usage for each configuration. An incomplete bio remains partial. Unknown billing, reasoning tokens or effective settings remain unknown.

Open **Recorded response** to inspect per-check retained structured output, score, expected criterion, model, requested native settings and reported usage. Expected criteria are separate from actual output. GCB retains only allowlisted parsed fixture responses; arbitrary text, original formatting and hidden thinking are unavailable. Missing responses are labeled explicitly and never reconstructed from a score. Details load only when opened, are bounded, and are invalidated when the target or evidence changes.

In **Personal routing**, choose **Preview recommendations** for role-specific eligibility, comparisons and reasons. Recommendations are scoped to the selected target's configurations. They can explain why no configuration qualifies. Synthetic results never establish real-model suitability. Live routing, agent reassignment and unsupported pre-inference enforcement remain unavailable.

### Existing local Ollama models

In **Catalog → Research and benchmark**, choose **Prepare local smoke test** for an existing, available, selectable local Ollama model. The adapter requires that exact model to be configured with the native Ollama API and a plain `http://127.0.0.1:<port>` endpoint. Remote URLs, proxy/header configurations and cloud model references are unsupported. The endpoint comes from the bound OpenClaw configuration, not a user-entered URL.

Research uses GCB's existing Ollama adapter to inspect the installed artifact digest, metadata and native thinking choices. The smoke preset requests:

| Setting | Scope |
| --- | --- |
| Thinking | `think:false`, selected from the researched configuration |
| Context and output | `num_ctx:4096`, `num_predict:128` |
| Usage | One cumulative local inference attempt, concurrency one |
| Deadlines | 45-second call wait; 60-second runner budget |
| Coverage | First baseline case, `coding.guard`; partial bio only |

GCB's plan contains eight baseline cells, but this preset permits only one attempt. The remaining checks stay unmeasured. Reasoning contrasts are disabled, and a fresh consent cannot expand the exhausted plan. The desktop rechecks the native route; GCB verifies the installed metadata before dispatch.

Start live profiling from the ordinary desktop owner context; agent-attributed shell or subagent contexts are refused. GCB calls the existing loopback Ollama API directly. It does not pull models, install providers, activate a host plugin or restart the gateway. A run can cold-load the model, consume substantial memory and leave it resident under Ollama's defaults. Requested settings and deadlines are not independently verified enforcement, a RAM cap or a provider-termination guarantee.

The verified desktop live smoke used `qwen3.5:9b` on Ollama **0.40.15** with OpenClaw **2026.11.1**: one attempt passed `coding.guard`, with retained output `{"missing_guard":"empty_items"}`, 114 reported input tokens, 8 output tokens and approximately 9.74 seconds. Seven cells remained pending. This does not establish broad capability, reasoning-level performance, peak memory or real cancellation behavior. Billed-cost provenance remains unknown.

### Optional OpenClaw/Codex host adapter

GCB's narrowly supported subscription route requires its separately installed and explicitly configured [OpenClaw host bridge](https://github.com/Leogy101/governed-capability-broker/tree/main/integrations/openclaw-host). This desktop path has offline test coverage but has not been live-validated for this release. Other catalog providers may be registered without having a supported profiling adapter.

Use **Add OpenClaw target** only with a reviewed, nonsecret snapshot matching GCB's documented schema. Do not import an OpenClaw configuration or credentials file. The desktop checks current model availability, selection policy, reasoning metadata and metadata-only bridge readiness through native authentication. Stale or disconnected targets remain unavailable.

The desktop does not install the bridge, activate it, change accounts or allowlists, or restart the gateway. Setup and any required restart are separate native administrative actions. Host output settings may be advisory; hidden provider requests, retries and billing can remain unknown. Review possible subscription/provider usage explicitly before every authorized run or resume.

## Saved data and recovery

OpenClaw keeps accepted conversations and owns execution. OpenClaw+ saves appearance preferences, its personal Models registry and GCB connection/profile records in its application support directory. GCB stores evidence in separate offline, local Ollama and host SQLite databases. Benchmark inputs use GCB fixtures, not your conversation history or project files.

If disconnected, check the gateway in original OpenClaw, then choose **Reconnect** and refresh Models. A changed model or configuration may require research again before review. A changed conversation identity requires selecting the refreshed conversation again. Unconfirmed writes should be inspected before retrying.

If GCB is unavailable, reconnect its reviewed executable. If profile storage is invalid or externally changed, preserve it and resolve the reported problem before making more changes; the app does not silently overwrite it or replay work. Quit before backing up app-owned profile files. Retain existing evidence when switching app versions; older previews may not understand newer target types.
