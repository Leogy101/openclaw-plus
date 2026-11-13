'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const desktop = path.resolve(__dirname, '..');
const root = path.dirname(desktop);
const tests = path.join(root, 'tests');
const mode = process.argv[2] || 'unit';
const files = fs.readdirSync(tests).filter(name => /\.spec\.(?:cjs|mjs)$/.test(name)).sort();
const native = files.filter(name => name.endsWith('-desktop.spec.cjs'));
const historical = ['prototype.spec.cjs'];
const modes = {
  unit: [{ name: 'unit', args: ['--test', ...files.filter(name => !native.includes(name) && !historical.includes(name)).map(name => path.join(tests, name))] }],
  native: native.map(name => ({ name, args: [path.join(tests, name)] })),
  prototype: [{ name: 'prototype', args: [path.join(tests, 'prototype.spec.cjs')] }],
};
if (!Object.hasOwn(modes, mode)) throw new Error('Choose unit, native, or prototype.');
if (mode === 'native' && (process.platform !== 'darwin' || process.arch !== 'arm64')) {
  throw new Error('Native desktop checks require Apple Silicon macOS and an active graphical session.');
}
if (mode === 'native' && !fs.existsSync(path.join(desktop, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'))) {
  throw new Error('Electron runtime is not installed. From the repository root, run npm run setup:electron --prefix desktop, then retry native tests.');
}
const runs = path.join(root, 'evidence', 'runs');
fs.mkdirSync(runs, { recursive: true });
const evidence = fs.mkdtempSync(path.join(runs, new Date().toISOString().replace(/[:.]/g, '-') + '-' + mode + '-'));
const env = { ...process.env, OPENCLAW_PLUS_EVIDENCE_ROOT: evidence };
delete env.ELECTRON_RUN_AS_NODE;
const results = [];

async function run(job) {
  console.log(`Running ${job.name}`);
  const log = fs.createWriteStream(path.join(evidence, job.name + '.log'));
  const started = Date.now();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, job.args, { cwd: root, env, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
    child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  }).finally(() => log.end());
  results.push({ name: job.name, exitCode: code, elapsedMs: Date.now() - started });
  return code === 0;
}

(async () => {
  console.log(`Evidence: ${evidence}`);
  try {
    if (mode === 'native' && !await run({ name: 'prepare-ui', args: [path.join(__dirname, 'prepare-ui.cjs')] })) {
      process.exitCode = 1; return;
    }
    // Electron suites deliberately run serially so they do not compete for native focus.
    for (const job of modes[mode]) if (!await run(job)) process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), mode, results }, null, 2));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
