# OpenClaw+ third-party notices

OpenClaw+ is an independent, unofficial application. Its original code and documentation use the [MIT License](LICENSE). The components below retain their separate licenses; this summary does not replace their complete notices. The application license is included in packaged builds at `app.asar/licenses/OpenClaw+.LICENSE`.

## Components included in the desktop package

| Component | Version | License and packaged notice |
| --- | --- | --- |
| Electron | 45.3.0 | MIT and bundled third-party notices. The complete distribution `LICENSE` and `LICENSES.chromium.html` are copied into `app.asar/licenses/`; Electron’s platform bundle also retains its distribution resources. |
| xterm.js (`@xterm/xterm`) | 6.0.0 | MIT. The complete package license is copied unchanged to `app.asar/renderer/vendor/xterm.LICENSE`. |
| xterm fit addon (`@xterm/addon-fit`) | 0.11.0 | MIT. The complete package license is copied unchanged to `app.asar/renderer/vendor/addon-fit.LICENSE`. |

The renderer uses locally packaged xterm JavaScript and CSS. It does not load these components from a CDN. `desktop/scripts/prepare-ui.cjs` copies the browser assets and both xterm licenses; `desktop/scripts/package.cjs` includes the Electron notices. The original package notices remain available in the installed development dependencies.

Upstream references: [Electron](https://github.com/electron/electron), [xterm.js 6.0.0 license](https://github.com/xtermjs/xterm.js/blob/6.0.0/LICENSE), [fit addon 0.11.0 package](https://github.com/xtermjs/xterm.js/blob/6.0.0/addons/addon-fit/package.json).

## Development tools and external runtime

Playwright 1.62.1 is an Apache-2.0 development dependency used only for isolated verification. It and its managed browser downloads are not copied into the application package. Build tools and their transitive dependencies retain the notices supplied in their npm packages and are likewise excluded from the staged application source.

OpenClaw is not bundled. The application connects to the separately installed OpenClaw gateway and loads supported SDK exports from that installation. OpenClaw and any configured providers, plugins or tools retain their own licenses and terms. This application’s notices do not replace those of the separately installed runtime.

## Project artwork

The supplied OpenClaw+ logo is retained intact in `desktop/assets/openclaw-plus-logo.png`. The macOS application icon contains resized versions of that image. The project name and artwork are excluded from the code license. No trademark rights or separate artwork reuse license are granted.
