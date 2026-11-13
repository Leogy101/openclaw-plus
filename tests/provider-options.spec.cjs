'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readProviderOptions } = require('../desktop/src/provider-options.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-provider-options-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file;
  };
  write('package.json', { name: 'openclaw', version: '2027.1.0-fixture' });
  fs.mkdirSync(path.join(root, 'dist/extensions'), { recursive: true });
  write('scripts/lib/official-external-provider-catalog.json', { entries: [] });
  return { root, write, read: () => readProviderOptions({ installRoot: root, platform: 'darwin' }) };
}
const choice = (provider, extra = {}) => ({ provider, method: 'api-key', choiceId: `${provider}-api-key`,
  choiceLabel: `${provider} API key`, groupId: provider, groupLabel: provider, ...extra });
const external = (plugin, providers) => ({ openclaw: { plugin: { id: plugin }, providers } });

test('native provider metadata supplies choices independently of configured models, with exact groups and aliases', t => {
  const f = fixture(t);
  f.write('dist/extensions/first/openclaw.plugin.json', { id: 'first', providerAuthAliases: { 'first-alias': 'first', unrelated: 'other' },
    providerAuthChoices: [choice('first', { groupId: 'family', groupLabel: 'Family' }),
      choice('second', { groupId: 'family', groupLabel: 'Family' })] });
  f.write('scripts/lib/official-external-provider-catalog.json', { entries: [
    external('first', [{ id: 'suppressed', authChoices: [choice('suppressed')] }]),
    external('third', [{ id: 'third', aliases: ['third-exact-alias'], authChoices: [choice('third')] }]),
    external('duplicate', [{ id: 'third', authChoices: [choice('third')] }])
  ] });
  const result = f.read();
  assert.equal(result.status, 'available'); assert.equal(result.version, '2027.1.0-fixture');
  assert.equal(result.source, 'installed-openclaw-metadata');
  assert.deepEqual(result.items.map(row => row.id), ['custom', 'family', 'third']);
  assert.deepEqual(result.items.find(row => row.id === 'family').providerIds, ['first', 'first-alias', 'second']);
  assert.deepEqual(result.items.find(row => row.id === 'third').providerIds, ['third', 'third-exact-alias']);
  assert.equal(result.items.find(row => row.id === 'third').methods.length, 1);
  assert.deepEqual(result.items.find(row => row.id === 'custom').providerIds, []);
  assert.match(result.limitations.join(' '), /user-installed.*detection-only/);
});

test('platform, visibility and workload scope preserve the native visible text onboarding boundary', t => {
  const f = fixture(t);
  const choices = [choice('allowed'), choice('mac', { platforms: ['darwin'] }), choice('linux', { platforms: ['linux'] }),
    choice('image', { onboardingScopes: ['image-generation'] }), choice('manual', { assistantVisibility: 'manual-only' }),
    choice('detected', { assistantVisibility: 'detected-only' }), choice('none', { platforms: [] }),
    choice('mixed', { onboardingScopes: ['text-inference', 'music-generation'] })];
  f.write('dist/extensions/provider/openclaw.plugin.json', { id: 'provider', providerAuthChoices: choices });
  const result = f.read();
  assert.equal(result.status, 'available');
  assert.deepEqual(result.items.map(row => row.id), ['allowed', 'custom', 'mac', 'mixed']);
});

test('projection never executes plugin code or forwards endpoint, authentication, command or unknown fields', t => {
  const f = fixture(t), marker = path.join(f.root, 'executed');
  f.write('dist/extensions/provider/package.json', { main: 'index.js', scripts: { postinstall: 'exit 1' } });
  f.write('dist/extensions/provider/index.js', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`);
  f.write('dist/extensions/provider/openclaw.plugin.json', { id: 'provider', apiKey: 'fixture-secret',
    providerAuthChoices: [choice('safe', { apiKey: 'fixture-secret', command: 'arbitrary-command', endpoint: 'https://private.invalid',
      script: 'arbitrary-script', credentialOnly: true }), choice('unsafe', { groupLabel: '<script>bad</script>' }),
      choice('../outside'), choice('future', { assistantVisibility: 'unexpected' })] });
  const result = f.read();
  assert.equal(result.status, 'partial'); assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(result.items.map(row => row.id), ['custom', 'safe']);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|private\.invalid|arbitrary|<script>|credentialOnly/);
});

test('missing, malformed and unknown metadata remain visible as partial or unavailable', t => {
  const f = fixture(t);
  f.write('dist/extensions/valid/openclaw.plugin.json', { id: 'valid', providerAuthChoices: [choice('valid')] });
  f.write('dist/extensions/bad/openclaw.plugin.json', '{');
  f.write('dist/extensions/future/openclaw.plugin.json', { id: 'future', providerAuthChoices: {} });
  fs.unlinkSync(path.join(f.root, 'scripts/lib/official-external-provider-catalog.json'));
  assert.equal(f.read().status, 'partial');
  assert.deepEqual(f.read().items.map(row => row.id), ['custom', 'valid']);
  assert.ok(f.read().limitations.length > 1);
  const missing = readProviderOptions({ installRoot: path.join(f.root, 'missing') });
  assert.equal(missing.status, 'unavailable'); assert.deepEqual(missing.items, []);
  f.write('package.json', { name: 'unrelated-package', version: '1.0' });
  assert.equal(f.read().status, 'unavailable');
  assert.equal(readProviderOptions({ installRoot: '../relative' }).status, 'unavailable');
});

test('metadata size and entry limits are enforced without returning oversized input', t => {
  const f = fixture(t);
  f.write('dist/extensions/large/openclaw.plugin.json', ' '.repeat(1024 * 1024 + 1));
  f.write('scripts/lib/official-external-provider-catalog.json', { entries: Array.from({ length: 513 }, () => ({})) });
  const result = f.read(); assert.equal(result.status, 'unavailable'); assert.deepEqual(result.items, []);
  assert.ok(JSON.stringify(result).length < 1500);
  f.write('scripts/lib/official-external-provider-catalog.json', { entries: [] });
  f.write('dist/extensions/large/openclaw.plugin.json', { id: 'large', providerAuthChoices: Array.from({ length: 513 }, () => choice('one')) });
  assert.equal(f.read().status, 'partial');
  assert.deepEqual(f.read().items.map(row => row.id), ['custom']);
});

test('symlinked metadata and extension directories cannot escape the installation or redirect into secrets', t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-provider-options-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'openclaw.plugin.json'), JSON.stringify({ id: 'outside', providerAuthChoices: [choice('outside')] }));
  fs.symlinkSync(outside, path.join(f.root, 'dist/extensions/linked'));
  fs.mkdirSync(path.join(f.root, 'dist/extensions/leaf'));
  fs.symlinkSync(path.join(outside, 'openclaw.plugin.json'), path.join(f.root, 'dist/extensions/leaf/openclaw.plugin.json'));
  f.write('private.json', { id: 'private', providerAuthChoices: [choice('private')] });
  fs.mkdirSync(path.join(f.root, 'dist/extensions/inside'));
  fs.symlinkSync(path.join(f.root, 'private.json'), path.join(f.root, 'dist/extensions/inside/openclaw.plugin.json'));
  const result = f.read(); assert.equal(result.status, 'partial');
  assert.deepEqual(result.items.map(row => row.id), ['custom']); assert.doesNotMatch(JSON.stringify(result), /outside|private/);
});

test('conflicting group names and unsupported descriptor-only setup do not invent provider labels', t => {
  const f = fixture(t);
  f.write('dist/extensions/provider/openclaw.plugin.json', { id: 'provider', providerAuthChoices: [choice('one', { groupId: 'same', groupLabel: 'Original' }),
    choice('two', { groupId: 'same', groupLabel: 'Conflicting' }), choice('missing', { groupLabel: undefined, choiceLabel: undefined })] });
  f.write('dist/extensions/descriptor/openclaw.plugin.json', { id: 'descriptor', setup: { providers: [{ id: 'descriptor', authMethods: ['api-key'] }] } });
  f.write('dist/extensions/descriptor/package.json', { openclaw: { setupEntry: './setup.js' } });
  const result = f.read(); assert.equal(result.status, 'partial');
  assert.deepEqual(result.items.map(row => row.id), ['custom', 'same']);
  assert.deepEqual(result.items.find(row => row.id === 'same').providerIds, ['one']);
});

test('native descriptor fallback includes additional provider routes without loading setup runtime', t => {
  const f = fixture(t);
  f.write('dist/extensions/provider/openclaw.plugin.json', { id: 'provider',
    providerAuthChoices: [choice('declared')],
    setup: { providers: [{ id: 'declared', authMethods: ['api-key'] }, { id: 'google-vertex', authMethods: ['api-key', 'oauth'] }] } });
  f.write('dist/extensions/provider/package.json', { openclaw: { extensions: ['./index.js'] } });
  const result = f.read(); assert.equal(result.status, 'available');
  assert.deepEqual(result.items.map(row => row.id), ['custom', 'declared', 'google-vertex']);
  assert.deepEqual(result.items.find(row => row.id === 'google-vertex'), { id: 'google-vertex', label: 'Google Vertex',
    providerIds: ['google-vertex'], methods: [{ id: 'google-vertex-api-key', label: 'Google Vertex API key' },
      { id: 'google-vertex-oauth', label: 'Google Vertex OAuth' }] });
  assert.equal(result.items.find(row => row.id === 'declared').methods.length, 1);
});

test('runtime ownership is respected even alongside explicit choices; metadata-only declarations may opt out', t => {
  const f = fixture(t);
  const file = 'dist/extensions/provider/openclaw.plugin.json';
  const manifest = { id: 'provider', providerAuthChoices: [choice('declared')],
    setup: { providers: [{ id: 'runtime', authMethods: ['api-key'] }] } };
  f.write(file, manifest); f.write('dist/extensions/provider/package.json', { openclaw: { setupEntry: './setup.js' } });
  f.write('dist/extensions/provider/setup.js', 'throw new Error("must not execute");');
  assert.equal(f.read().status, 'partial');
  assert.deepEqual(f.read().items.map(row => row.id), ['custom', 'declared']);
  f.write(file, { ...manifest, setup: { ...manifest.setup, requiresRuntime: false } });
  assert.equal(f.read().status, 'available');
  assert.deepEqual(f.read().items.map(row => row.id), ['custom', 'declared', 'runtime']);
});

test('malformed descriptor ownership and aliases are reported instead of silently claiming full coverage', t => {
  const f = fixture(t);
  f.write('dist/extensions/provider/openclaw.plugin.json', { id: 'provider', providerAuthChoices: [choice('declared')],
    providerAuthAliases: 'unsupported', setup: { providers: [{ id: 'descriptor', authMethods: ['api-key'] }] } });
  f.write('dist/extensions/provider/package.json', { openclaw: { setupEntry: { unexpected: true } } });
  const result = f.read(); assert.equal(result.status, 'partial');
  assert.deepEqual(result.items.map(row => row.id), ['custom', 'declared']);
  assert.match(result.limitations.join(' '), /aliases.*ownership/);
});
