'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root,'renderer'), {recursive:true});
for(const name of ['index.html','app.css','app.js','models.css','models-view.mjs','content.mjs','terminal-view.mjs','read-aloud.mjs','voice-view.mjs','voice-capture-worklet.js']) {
  fs.copyFileSync(path.join(root,'ui',name), path.join(root,'renderer',name));
}
const vendor = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(vendor, {recursive:true});
for (const [packageName, source, destination] of [
  ['@xterm/xterm', 'lib/xterm.mjs', 'xterm.mjs'],
  ['@xterm/xterm', 'css/xterm.css', 'xterm.css'],
  ['@xterm/xterm', 'LICENSE', 'xterm.LICENSE'],
  ['@xterm/addon-fit', 'lib/addon-fit.mjs', 'addon-fit.mjs'],
  ['@xterm/addon-fit', 'LICENSE', 'addon-fit.LICENSE'],
]) {
  fs.copyFileSync(path.join(root, 'node_modules', packageName, source), path.join(vendor, destination));
}
console.log('Prepared the OpenClaw+ desktop interface.');
