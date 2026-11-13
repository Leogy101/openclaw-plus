'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE = 1024 * 1024, MAX_TOTAL = 16 * MAX_FILE, MAX_ENTRIES = 512;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value);
const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 &&
  !/[<>\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value);
// OpenClaw's documented descriptor fallback uses these generic acronyms and
// title-cases IDs; this does not maintain a separate list of provider brands.
const descriptorAcronyms = new Map([['api', 'API'], ['jwt', 'JWT'], ['oauth', 'OAuth'], ['oidc', 'OIDC'],
  ['pkce', 'PKCE'], ['saml', 'SAML'], ['sso', 'SSO']]);
const descriptorLabel = value => value.split(/[-_\s]+/u).filter(Boolean).map(part =>
  descriptorAcronyms.get(part.toLowerCase()) ?? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(' ');

// Read published JSON metadata only. Never import plugin code or inspect credentials/config.
function readProviderOptions({ installRoot = '/opt/homebrew/lib/node_modules/openclaw', platform = process.platform } = {}) {
  const limitations = new Set(), groups = new Map(), seenChoices = new Set(), installed = new Set();
  let root, bytes = 0, partial = false, sourceRead = false, version;
  const problem = message => { partial = true; limitations.add(message); };
  const result = () => ({ status: sourceRead ? partial ? 'partial' : 'available' : 'unavailable',
    items: [...groups.values()].map(group => ({ ...group, providerIds: [...group.providerIds].sort(),
      methods: [...group.methods.values()] })).sort((a, b) => a.label.localeCompare(b.label)),
    source: 'installed-openclaw-metadata', ...(version ? { version } : {}), limitations: [...limitations] });
  function safePath(relative) {
    const file = path.join(root, relative);
    if (path.relative(root, file).startsWith('..') || path.isAbsolute(path.relative(root, file))) throw new Error('Outside installation');
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked metadata');
    }
    if (fs.realpathSync(file) !== file) throw new Error('Unexpected metadata path');
    return file;
  }
  function json(relative) {
    const file = safePath(relative), before = fs.lstatSync(file);
    if (!before.isFile() || before.size > MAX_FILE || bytes + before.size > MAX_TOTAL) throw new Error('Metadata limit');
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_FILE || bytes + stat.size > MAX_TOTAL) throw new Error('Metadata changed');
      // A bounded read also handles a file growing after the size check.
      const buffer = Buffer.alloc(stat.size + 1), length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      if (length !== stat.size) throw new Error('Metadata changed');
      bytes += length;
      return JSON.parse(buffer.subarray(0, length).toString('utf8'));
    } finally { fs.closeSync(descriptor); }
  }
  function array(value) {
    if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
      problem('Some provider metadata uses an unsupported format or exceeds the supported limit.');
      return [];
    }
    return value;
  }
  function add(choice, provider, aliases = []) {
    if (!object(choice) || !id(provider) || !id(choice.method) || !id(choice.choiceId)) {
      problem('Some provider choices could not be read safely.'); return;
    }
    if (choice.platforms !== undefined) {
      if (!Array.isArray(choice.platforms) || choice.platforms.length > 16 || choice.platforms.some(value => !id(value))) {
        problem('Some provider platform requirements could not be read.'); return;
      }
      if (!choice.platforms.includes(platform)) return;
    }
    if (choice.onboardingScopes !== undefined) {
      const scopes = array(choice.onboardingScopes);
      if (scopes.some(scope => !['text-inference', 'image-generation', 'music-generation'].includes(scope))) {
        problem('Some provider onboarding categories are not supported by this app.'); return;
      }
      if (!scopes.includes('text-inference')) return;
    }
    if (['manual-only', 'detected-only'].includes(choice.assistantVisibility)) return;
    if (choice.assistantVisibility !== undefined && choice.assistantVisibility !== 'visible') {
      problem('Some provider visibility requirements could not be read.'); return;
    }
    const groupId = choice.groupId ?? provider;
    const groupLabel = choice.groupLabel ?? choice.choiceLabel;
    if (!id(groupId) || !label(groupLabel) || !label(choice.choiceLabel) || groupId === 'custom') {
      problem('Some provider names could not be read safely.'); return;
    }
    if (seenChoices.has(choice.choiceId)) return;
    if (seenChoices.size >= MAX_ENTRIES) {
      problem('Provider choices exceed the supported limit.'); return;
    }
    if (groups.size >= MAX_ENTRIES && !groups.has(groupId)) {
      problem('Provider options exceed the supported limit.'); return;
    }
    const group = groups.get(groupId) ?? { id: groupId, label: groupLabel, providerIds: new Set(), methods: new Map() };
    if (group.label !== groupLabel) { problem('Some provider groups have conflicting names.'); return; }
    group.providerIds.add(provider);
    for (const alias of array(aliases)) {
      if (id(alias)) group.providerIds.add(alias);
      else problem('Some provider aliases could not be read safely.');
    }
    group.methods.set(choice.choiceId, { id: choice.choiceId, label: choice.choiceLabel });
    groups.set(groupId, group); seenChoices.add(choice.choiceId);
  }
  try {
    if (typeof installRoot !== 'string' || !path.isAbsolute(installRoot)) throw new Error('Installation required');
    root = fs.realpathSync(installRoot);
    const pkg = json('package.json');
    if (!object(pkg) || pkg.name !== 'openclaw' || !label(pkg.version)) throw new Error('Not OpenClaw');
    version = pkg.version;
  } catch {
    limitations.add('The installed OpenClaw provider metadata is unavailable.'); return result();
  }
  try {
    const directory = safePath(path.join('dist', 'extensions'));
    const entries = [];
    const dir = fs.opendirSync(directory);
    try {
      for (let entry; (entry = dir.readSync()) !== null;) {
        if (entries.length >= MAX_ENTRIES) throw new Error('Extension limit');
        entries.push(entry);
      }
    } finally { dir.closeSync(); }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) {
        if (entry.isSymbolicLink()) problem('Linked plugin metadata was omitted.');
        continue;
      }
      try {
        const manifest = json(path.join('dist', 'extensions', entry.name, 'openclaw.plugin.json'));
        if (!object(manifest) || !id(manifest.id)) throw new Error('Unsupported manifest');
        installed.add(manifest.id); sourceRead = true;
        const aliasesFor = provider => object(manifest.providerAuthAliases) ? Object.entries(manifest.providerAuthAliases)
          .filter(([, target]) => target === provider).map(([alias]) => alias) : [];
        if (manifest.providerAuthAliases !== undefined && (!object(manifest.providerAuthAliases) ||
            Object.entries(manifest.providerAuthAliases).some(([alias, target]) => !id(alias) || !id(target)))) {
          problem('Some provider aliases could not be read safely.');
        }
        const declared = new Set();
        if (manifest.providerAuthChoices !== undefined) {
          for (const choice of array(manifest.providerAuthChoices)) {
            if (id(choice?.provider) && id(choice?.method)) declared.add(`${choice.provider}::${choice.method}`);
            add(choice, choice?.provider, aliasesFor(choice?.provider));
          }
        }
        if (manifest.setup?.providers !== undefined) {
          const descriptors = [];
          for (const provider of array(manifest.setup.providers)) {
            if (!object(provider) || !id(provider.id)) { problem('Some provider setup descriptors could not be read.'); continue; }
            if (provider.authMethods !== undefined) for (const method of array(provider.authMethods)) {
              if (!id(method)) { problem('Some provider setup methods could not be read.'); continue; }
              if (!declared.has(`${provider.id}::${method}`)) descriptors.push({ provider: provider.id, method });
            }
          }
          if (descriptors.length) {
            let runtimeOwned = false;
            if (manifest.setup.requiresRuntime !== false) {
              // package.json declares the setup entry. Its code is never loaded.
              try {
                const pkg = json(path.join('dist', 'extensions', entry.name, 'package.json'));
                if (!object(pkg)) throw new Error('Unsupported package');
                const setupEntry = pkg.openclaw?.setupEntry;
                if (setupEntry !== undefined && typeof setupEntry !== 'string') throw new Error('Unsupported setup entry');
                runtimeOwned = typeof setupEntry === 'string' && setupEntry.trim().length > 0;
              } catch (error) {
                if (error.code !== 'ENOENT') {
                  problem('Some provider setup ownership could not be read safely.');
                  runtimeOwned = true;
                }
              }
            }
            if (runtimeOwned) problem('Some plugin setup choices require native OpenClaw onboarding.');
            else for (const { provider, method } of descriptors) add({ method, choiceId: `${provider}-${method}`,
              choiceLabel: `${descriptorLabel(provider)} ${method === 'api-key' ? 'API key' : descriptorLabel(method)}`,
              groupId: provider, groupLabel: descriptorLabel(provider) }, provider, aliasesFor(provider));
          }
        }
      } catch (error) {
        // The extensions directory also contains supporting modules with no manifest.
        if (error.code !== 'ENOENT') problem('Some installed plugin metadata could not be read safely.');
      }
    }
  } catch { problem('The packaged plugin provider list could not be read safely.'); }
  try {
    const catalog = json(path.join('scripts', 'lib', 'official-external-provider-catalog.json'));
    if (!object(catalog) || !Array.isArray(catalog.entries) || catalog.entries.length > MAX_ENTRIES) throw new Error('Unsupported catalog');
    sourceRead = true;
    for (const entry of catalog.entries) {
      const metadata = entry?.openclaw;
      if (!object(metadata) || !id(metadata.plugin?.id)) { problem('Some installable provider metadata could not be read.'); continue; }
      if (installed.has(metadata.plugin.id)) continue;
      for (const provider of array(metadata.providers)) {
        if (!object(provider) || !id(provider.id)) { problem('Some installable provider IDs could not be read.'); continue; }
        if (provider.authChoices !== undefined) for (const choice of array(provider.authChoices)) add(choice, provider.id, provider.aliases ?? []);
      }
    }
  } catch { problem('The packaged installable provider list could not be read safely.'); }
  if (sourceRead) {
    // This is OpenClaw's documented core endpoint option, not an invented provider.
    groups.set('custom', { id: 'custom', label: 'Custom Provider', providerIds: new Set(),
      methods: new Map([['custom-api-key', { id: 'custom-api-key', label: 'Custom Provider' }]]) });
    limitations.add('Options reflect packaged OpenClaw metadata. Additional user-installed plugins and detection-only choices require native OpenClaw onboarding.');
  }
  return result();
}

module.exports = { readProviderOptions };
