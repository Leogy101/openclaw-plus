# OpenClaw+ third-party notices

OpenClaw+ is an independent, unofficial application. Its original code and documentation use the [MIT License](LICENSE). The components below retain their separate licenses; this summary does not replace their complete notices. The application license is included in packaged builds at `app.asar/licenses/OpenClaw+.LICENSE`.

## Components included in the desktop package

| Component | Version | License and packaged notice |
| --- | --- | --- |
| Electron | 45.3.0 | MIT and bundled third-party notices. The complete distribution `LICENSE` and `LICENSES.chromium.html` are copied into `app.asar/licenses/`; Electron’s platform bundle also retains its distribution resources. |
| Mantle framework | Electron-pinned `2a8e2123a3931038179ee06105c9e6ec336b12ea` | MIT and included Proton/Bitswift notice. The complete upstream license is copied unchanged to `app.asar/licenses/Mantle.LICENSE.md`. |
| ReactiveObjC framework | Electron-pinned `74ab5baccc6f7202c8ac69a8d1e152c29dc1ea76` | MIT. The complete upstream license is copied unchanged to `app.asar/licenses/ReactiveObjC.LICENSE.md`. |
| xterm.js (`@xterm/xterm`) | 6.0.0 | MIT. The complete package license is copied unchanged to `app.asar/renderer/vendor/xterm.LICENSE`. |
| xterm fit addon (`@xterm/addon-fit`) | 0.11.0 | MIT. The complete package license is copied unchanged to `app.asar/renderer/vendor/addon-fit.LICENSE`. |

The renderer uses locally packaged xterm JavaScript and CSS. It does not load these components from a CDN. `desktop/scripts/prepare-ui.cjs` copies the browser assets and both xterm licenses; `desktop/scripts/package.cjs` includes the Electron notices. The original package notices remain available in the installed development dependencies.

The two additional macOS framework licenses are retained in `desktop/licenses/` because Electron's combined notice file does not include them. Their revisions come from [Electron 45.3.0's dependency manifest](https://github.com/electron/electron/blob/v45.3.0/DEPS); source licenses are [Mantle](https://github.com/Mantle/Mantle/blob/2a8e2123a3931038179ee06105c9e6ec336b12ea/LICENSE.md) and [ReactiveObjC](https://github.com/ReactiveCocoa/ReactiveObjC/blob/74ab5baccc6f7202c8ac69a8d1e152c29dc1ea76/LICENSE.md). The Squirrel framework and its BinaryDelta notices are already included in Electron's `LICENSES.chromium.html`.

Upstream references: [Electron](https://github.com/electron/electron), [xterm.js 6.0.0 license](https://github.com/xtermjs/xterm.js/blob/6.0.0/LICENSE), [fit addon 0.11.0 package](https://github.com/xtermjs/xterm.js/blob/6.0.0/addons/addon-fit/package.json).

## Development tools and separately installed software

Playwright 1.62.1 is an Apache-2.0 development dependency used only for isolated verification. It and its managed browser downloads are not copied into the application package. Build tools and their transitive dependencies retain the notices supplied in their npm packages and are likewise excluded from the staged application source.

OpenClaw is not bundled. The application connects to the separately installed OpenClaw gateway and loads supported SDK exports from that installation. OpenClaw and any configured providers, plugins or tools retain their own licenses and terms. This application’s notices do not replace those of the separately installed runtime.

[Governed Capability Broker (GCB)](https://github.com/Leogy101/governed-capability-broker) is optional, independently installed software, not a bundled engine or vendored dependency. The integration has been exercised with GCB `0.3.2a1`, distributed under [Apache-2.0](https://github.com/Leogy101/governed-capability-broker/blob/main/LICENSE) with its own [NOTICE](https://github.com/Leogy101/governed-capability-broker/blob/main/NOTICE). OpenClaw+ invokes its public CLI for research, plans, execution, evidence, capability bios and routing previews. GCB retains responsibility for its engine and license notices.

Ollama and other model runtimes, models and provider services are not bundled. Their software licenses, model licenses, authentication and service terms remain separate. No model weights, provider credentials or subscription rights are distributed with OpenClaw+. References to compatible projects and models do not imply endorsement.

## Project artwork

The supplied OpenClaw+ logo is retained intact in `desktop/assets/openclaw-plus-logo.png`. The macOS application icon contains resized versions of that image. The project name and artwork are excluded from the code license. No trademark rights or separate artwork reuse license are granted.
