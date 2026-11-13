'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assets = path.resolve(__dirname, '..', 'assets');
const source = path.join(assets, 'openclaw-plus-logo.png');
const iconset = path.join(assets, 'AppIcon.iconset');
const hash = () => createHash('sha256').update(fs.readFileSync(source)).digest('hex');
if (process.platform !== 'darwin') throw new Error('Icon conversion requires macOS sips and iconutil.');
const originalHash = hash();
fs.mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const pixels = String(size * scale);
    const output = path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
    execFileSync('/usr/bin/sips', ['--resampleHeightWidth', pixels, pixels, source, '--out', output], { stdio: 'ignore' });
  }
}
execFileSync('/usr/bin/iconutil', ['--convert', 'icns', iconset, '--output', path.join(assets, 'AppIcon.icns')], { stdio: 'inherit' });
if (hash() !== originalHash) throw new Error('The supplied source logo changed during conversion.');
console.log(`Generated macOS icon sizes from the intact logo. Source SHA-256: ${originalHash}`);
