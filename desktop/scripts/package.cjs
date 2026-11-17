'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const project = path.dirname(root);

(async () => {
  const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
  if (['LICENSE', 'LICENSES.chromium.html', 'Electron.app/Contents/MacOS/Electron'].some(name => !fs.existsSync(path.join(electronDist, name)))) {
    throw new Error('Electron runtime is missing or incomplete. From the repository root, run npm run setup:electron --prefix desktop, then retry packaging.');
  }
  const { packager } = await import('@electron/packager');
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  execFileSync(process.execPath, [path.join(__dirname, 'prepare-ui.cjs')], { stdio: 'inherit' });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const stagingRoot = path.join(project, '.cache', 'staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const stage = fs.mkdtempSync(path.join(stagingRoot, 'desktop-'));
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: pkg.name, productName: pkg.productName, version: pkg.version,
    main: 'src/main.cjs', private: true, description: pkg.description, author: pkg.author, license: pkg.license,
  }, null, 2));
  for (const name of ['src', 'renderer', 'shared']) fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
  const notices = path.join(stage, 'licenses');
  fs.mkdirSync(notices, { recursive: true });
  fs.copyFileSync(path.join(project, 'LICENSE'), path.join(notices, 'OpenClaw+.LICENSE'));
  fs.copyFileSync(path.join(project, 'THIRD_PARTY_NOTICES.md'), path.join(notices, 'THIRD_PARTY_NOTICES.md'));
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    fs.copyFileSync(path.join(root, 'node_modules/electron/dist', name), path.join(notices, name));
  }
  for (const name of ['Mantle.LICENSE.md', 'ReactiveObjC.LICENSE.md']) {
    fs.copyFileSync(path.join(root, 'licenses', name), path.join(notices, name));
  }
  const outputs = await packager({
    dir: stage, name: pkg.productName, platform: 'darwin', arch: 'arm64',
    electronVersion: pkg.devDependencies.electron,
    out: path.join(project, 'releases', pkg.version), overwrite: true,
    tmpdir: path.join(project, '.cache', 'packager'),
    download: { cacheRoot: path.join(project, '.cache', 'electron') },
    asar: true, extraResource: ['approval-rpc.cjs','composer-rpc.cjs','terminal-rpc.cjs','voice-rpc.cjs','model-rpc.cjs','gcb-openclaw.cjs'].map(name => path.join(root,'src',name)), prune: false, icon: path.join(root, 'assets', 'AppIcon.icns'),
    appBundleId: 'app.openclawplus.desktop', appVersion: pkg.version,
    buildVersion: pkg.version, appCategoryType: 'public.app-category.productivity',
    extendInfo: { CFBundleDisplayName: pkg.productName, NSHumanReadableCopyright: 'Copyright © 2026 OpenClaw+ contributors',
      NSMicrophoneUsageDescription: 'Use your microphone when you choose Dictate or Talk in OpenClaw+.' },
  });
  for (const output of outputs) {
    const app = path.join(output, pkg.productName + '.app');
    await flipFuses(app, { version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      resetAdHocDarwinSignature: true,
    });
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
    console.log('Packaged and locally signed:', app);
  }
  fs.rmSync(stage, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
