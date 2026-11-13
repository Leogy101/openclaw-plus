'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const desktopRequire = createRequire(path.join(root, 'desktop', 'package.json'));

function evidenceDirectory(suite) {
  if (!/^[a-z][a-z0-9-]*$/.test(suite)) throw new Error('Invalid test evidence name.');
  const base = process.env.OPENCLAW_PLUS_EVIDENCE_ROOT || path.join(root, 'evidence', 'runs');
  if (!path.isAbsolute(base)) throw new Error('OPENCLAW_PLUS_EVIDENCE_ROOT must be an absolute directory.');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, suite + '-'));
}

module.exports = { playwright: desktopRequire('playwright'), evidenceDirectory };
