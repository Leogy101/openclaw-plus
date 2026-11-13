'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ReadError } = require('./gateway-cli.cjs');
const { readProviderOptions } = require('./provider-options.cjs');
const MAX_FILE = 2 * 1024 * 1024, CACHE_MS = 60000, REVIEW_MS = 5 * 60000, PROVIDER_CACHE_MS = 5 * 60000;
const OPERATIONS = Object.freeze(['modelsOverview','modelsRefresh','modelsPlanRegistration','modelsRegister','modelsOnboarding']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max = 512) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw new ReadError(code, message); };
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const empty = () => ({ schemaVersion: 1, revision: 0, registrations: [], lastSnapshot: null });

class ModelManagerService {
  constructor({ gateway, registryPath, now = Date.now, providerOptions = readProviderOptions }) {
    if (typeof gateway !== 'function' || !path.isAbsolute(registryPath || '')) throw new TypeError('A gateway provider and private registry path are required.');
    this.gateway = gateway; this.registryPath = registryPath; this.now = now;
    this.readProviderOptions = providerOptions; this.providerSetup = null; this.providerSetupAt = null;
    this.reviews = new Map(); this.document = empty(); this.storage = { status: 'ready', readOnly: false };
    this.native = null; this.pending = null; this.nativeOwner = null; this.savedBytes = null; this.registrationBusy = false; this.connectionEpoch = 0;
    this.ready = import('../shared/model-manager.mjs').then(logic => { this.logic = logic; this.loadStorage(); });
  }

  invalidateConnection() {
    this.connectionEpoch++; this.native = null; this.nativeOwner = null; this.pending = null; this.reviews.clear();
  }

  async handle(operation, input = {}) {
    const fields = { modelsOverview: [], modelsRefresh: [], modelsPlanRegistration: ['modelRef','reasoning'],
      modelsRegister: ['reviewToken','registryRevision'], modelsOnboarding: [] };
    if (!OPERATIONS.includes(operation) || !exact(input, fields[operation])) fail('INVALID','Unsupported Model Manager request.');
    await this.ready;
    if (operation === 'modelsOnboarding') return { kind: 'open-original-models', nativeChanges: false };
    if (operation === 'modelsOverview' || operation === 'modelsRefresh') {
      this.loadProviderOptions(operation === 'modelsRefresh');
      await this.loadNative(operation === 'modelsRefresh'); return this.overview();
    }
    if (operation === 'modelsPlanRegistration') return this.plan(input);
    return this.register(input);
  }

  loadProviderOptions(force = false) {
    if (!force && this.providerSetup && this.now() - this.providerSetupAt < PROVIDER_CACHE_MS) return;
    // Setup choices describe the installed client, not authentication, live
    // availability or permission. Keep them separate from saved model evidence.
    try { this.providerSetup = this.readProviderOptions(); }
    catch { this.providerSetup = { status: 'unavailable', items: [], source: 'installed-openclaw-metadata',
      limitations: ['The installed OpenClaw provider metadata could not be read safely.'] }; }
    this.providerSetupAt = this.now();
  }

  decorateCatalog(raw) {
    const catalog = this.logic.normalizeCatalog(raw);
    catalog.models = catalog.models.map(model => ({ ...model, metadataFingerprint: hash(this.logic.canonicalIdentity(this.logic.modelMetadata(model))) }));
    return catalog;
  }

  validateDocument(value) {
    if (!exact(value, ['schemaVersion','revision','registrations','lastSnapshot']) || value.schemaVersion !== 1 ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.registrations) || value.registrations.length > 500) throw new Error('Invalid registry');
    const ids = new Set(), variants = new Set();
    for (const row of value.registrations) {
      if (!exact(row, ['id','modelRef','provider','modelId','name','reasoning','runtimeId','metadataFingerprint','createdAt']) ||
          !string(row.id, 80) || !string(row.provider, 128) || row.provider.includes('/') || !string(row.modelId, 512) ||
          row.modelRef !== `${row.provider}/${row.modelId}` || !string(row.name, 200) ||
          row.reasoning !== null && !string(row.reasoning, 80) || row.runtimeId !== null && !string(row.runtimeId, 80) ||
          !/^[a-f0-9]{64}$/.test(row.metadataFingerprint || '') || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0) throw new Error('Invalid registration');
      const variant = JSON.stringify([row.modelRef,row.reasoning]);
      if (ids.has(row.id) || variants.has(variant)) throw new Error('Duplicate registration');
      ids.add(row.id); variants.add(variant);
    }
    if (value.lastSnapshot !== null) {
      const snapshot = value.lastSnapshot;
      if (!exact(snapshot, ['models','observedAt','capabilities','limitations']) || !Array.isArray(snapshot.models) || snapshot.models.length > 1000 ||
          !Number.isSafeInteger(snapshot.observedAt) || snapshot.observedAt < 0 ||
          !exact(snapshot.capabilities, ['modelsList','publishedModelCatalog','sessionScopedModelCatalog','modelSelectionPolicy']) ||
          Object.keys(snapshot.capabilities).length !== 4 || Object.values(snapshot.capabilities).some(flag => typeof flag !== 'boolean') ||
          !Array.isArray(snapshot.limitations) || snapshot.limitations.length > 12 || snapshot.limitations.some(item => !string(item, 500))) throw new Error('Invalid snapshot');
      const restored = this.decorateCatalog({ models: snapshot.models.map(model => ({ ...model, agentRuntime: { id: model.runtimeId } })) });
      if (this.logic.canonicalIdentity(restored.models) !== this.logic.canonicalIdentity(snapshot.models)) throw new Error('Invalid snapshot models');
    }
    return value;
  }

  readPrivate(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE || stat.mode & 0o077 ||
        typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Unsafe registry');
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const current = fs.fstatSync(descriptor);
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.size > MAX_FILE) throw new Error('Registry changed');
      return fs.readFileSync(descriptor, 'utf8');
    } finally { fs.closeSync(descriptor); }
  }

  loadStorage() {
    try {
      const bytes = this.readPrivate(this.registryPath);
      this.document = this.validateDocument(JSON.parse(bytes)); this.savedBytes = bytes;
    } catch (error) {
      let recovered = null, previousMissing = false;
      try { recovered = this.validateDocument(JSON.parse(this.readPrivate(this.registryPath + '.previous'))); }
      catch (previousError) { previousMissing = previousError.code === 'ENOENT'; }
      if (recovered) {
        this.document = recovered; this.storage = { status: 'recovered', readOnly: true,
          message: 'A previous local snapshot was recovered. Registration is paused until the current registry is repaired.' };
      } else if (error.code !== 'ENOENT' || !previousMissing) {
        this.storage = { status: 'unavailable', readOnly: true,
          message: 'The local model registry could not be read safely. No records were replaced.' };
      }
    }
  }

  ensureDirectory() {
    const directory = path.dirname(this.registryPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 ||
        typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Unsafe registry directory');
    return directory;
  }

  writeAtomic(file, bytes) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, file);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  save(document) {
    if (this.storage.readOnly) fail('STORAGE','The local registry needs recovery before it can be changed.');
    const bytes = JSON.stringify(this.validateDocument(document), null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX_FILE) fail('STORAGE','The local model snapshot exceeds the supported size. No registry data was replaced.');
    try {
      const directory = this.ensureDirectory();
      let current = null;
      try { current = this.readPrivate(this.registryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current !== this.savedBytes) fail('CONFLICT','The local registry changed outside this view. Reopen the application before registering a model.');
      if (current !== null) this.writeAtomic(this.registryPath + '.previous', current);
      this.writeAtomic(this.registryPath, bytes);
      // Electron's existing single-instance owner and synchronous commit keep
      // registry CAS/rename together; another application is not a store writer.
      const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      this.document = document; this.savedBytes = bytes;
    } catch (error) {
      if (error instanceof ReadError) throw error;
      fail('STORAGE','The local model registry could not be saved. Reopen it to verify the current record before trying again.');
    }
  }

  owner() {
    const base = this.gateway();
    if (!base || typeof base.transport?.modelRead !== 'function') fail('UNAVAILABLE','Model inventory is not supported by this connection.');
    return { base, generation: base.generation, epoch: this.connectionEpoch };
  }
  assertOwner(owner) {
    if (owner.epoch !== this.connectionEpoch || this.gateway() !== owner.base) fail('STALE','The OpenClaw connection changed. Reload the model inventory.');
    owner.base.assertCurrent(owner.generation);
  }

  async loadNative(force = false) {
    if (this.pending) return this.pending;
    let owner;
    try { owner = this.owner(); } catch { this.native = null; return; }
    if (!force && this.native?.connection.status === 'connected' && this.nativeOwner?.base === owner.base &&
        this.nativeOwner.generation === owner.generation && this.now() - this.native.catalog.observedAt < CACHE_MS) return;
    const observedAt = this.now();
    const promise = (async () => {
      try {
        const rawCapabilities = await owner.base.transport.modelRead('capabilities'); this.assertOwner(owner);
        const capabilities = this.logic.normalizeCapabilities(rawCapabilities);
        if (!capabilities.modelsList || !capabilities.publishedModelCatalog) {
          this.native = { connection: { status: 'unsupported', observedAt, capabilities,
            message: 'The gateway does not advertise the required passive model catalog. Use the original interface.' }, catalog: null };
          this.nativeOwner = owner; return;
        }
        const raw = await owner.base.transport.modelRead('catalog'); this.assertOwner(owner);
        const catalog = { ...this.decorateCatalog(raw), observedAt, stale: false };
        this.native = { connection: { status: 'connected', observedAt, capabilities,
          message: 'Native published inventory. Availability is not a model test or a session permission grant.' }, catalog };
        this.nativeOwner = owner;
        if (!this.storage.readOnly) {
          try {
            this.save({ ...this.document, lastSnapshot: { models: catalog.models, observedAt, capabilities, limitations: catalog.limitations } });
          } catch (error) {
            this.storage = { status: 'unavailable', readOnly: true, message: error.code === 'CONFLICT'
              ? 'The registry changed outside this view. Registration is paused; reopen the application.'
              : 'The last inventory could not be saved safely. Registration is paused; reopen the application.' };
          }
        }
      } catch {
        if (owner.epoch !== this.connectionEpoch || this.gateway() !== owner.base) return;
        this.native = { connection: { status: 'disconnected', observedAt, capabilities: this.native?.connection.capabilities ?? null,
          message: 'Native inventory could not be verified. The last local snapshot is shown when available.' }, catalog: null };
        this.nativeOwner = owner;
      }
    })();
    this.pending = promise;
    try { await promise; } finally { if (this.pending === promise) this.pending = null; }
  }

  overview() {
    const connection = this.native?.connection ?? { status: 'disconnected', observedAt: null, capabilities: null,
      message: 'Native inventory has not been verified in this connection.' };
    let catalog = this.native?.catalog;
    if (!catalog && this.document.lastSnapshot) {
      const snapshot = this.document.lastSnapshot;
      catalog = { ...this.decorateCatalog({ models: snapshot.models.map(model => ({ ...model, agentRuntime: { id: model.runtimeId } })) }),
        observedAt: snapshot.observedAt, stale: true, limitations: [...snapshot.limitations, 'Saved inventory only. Native availability must be rechecked.'] };
    }
    catalog ??= { models: [], providers: [], observedAt: null, stale: true, limitations: ['No verified native inventory has been loaded.'] };
    const connected = connection.status === 'connected' && !catalog.stale;
    const items = this.document.registrations.map(registration => ({ ...registration,
      ...this.logic.classifyRegistration(registration, { model: catalog.models.find(model => model.modelRef === registration.modelRef), connected, now: this.now() }) }));
    return structuredClone({ connection, registry: { revision: this.document.revision, items, ...this.storage }, catalog,
      providerSetup: this.providerSetup,
      actions: { canRegister: connected && !this.storage.readOnly && this.document.registrations.length < 500,
        canRefresh: true, canOnboard: true }, execution: 'unavailable', routing: 'preview-only',
      limitations: ['Registration saves a local reference only. Qualification checks, evidence imports, admission and task routing are unavailable.',
        'Provider discovery and sign-in stay in OpenClaw setup. Reloading reads prepared catalog and installed provider metadata.'] });
  }

  async plan(input) {
    if (!string(input.modelRef, 641) || input.reasoning !== undefined && input.reasoning !== null && !string(input.reasoning, 80)) fail('INVALID','Choose an exact advertised model and reasoning option.');
    await this.loadNative();
    const view = this.overview();
    if (!view.actions.canRegister) fail('UNAVAILABLE','Load a current native catalog and writable local registry before saving a reference.');
    const model = view.catalog.models.find(item => item.modelRef === input.modelRef);
    if (!model) fail('INVALID','That exact model reference is not in the published catalog.');
    const reasoning = input.reasoning ?? null;
    if (reasoning !== null && !model.thinkingLevels.some(level => level.id === reasoning)) fail('INVALID','That reasoning option is not advertised for this model.');
    if (this.document.registrations.some(item => item.modelRef === model.modelRef && item.reasoning === reasoning)) fail('CONFLICT','This exact model and reasoning reference is already registered.');
    for (const [token, review] of this.reviews) if (review.expiresAt <= this.now()) this.reviews.delete(token);
    while (this.reviews.size >= 16) this.reviews.delete(this.reviews.keys().next().value);
    const reviewToken = crypto.randomUUID();
    this.reviews.set(reviewToken, { model, reasoning, registryRevision: view.registry.revision,
      owner: this.nativeOwner, expiresAt: this.now() + REVIEW_MS, signature: this.logic.canonicalIdentity(model) });
    return { reviewToken, registryRevision: view.registry.revision, review: { title: 'Save local model reference',
      description: 'Save this exact native model reference in this app. This does not change OpenClaw settings, test a model, or approve live work.',
      modelRef: model.modelRef, provider: model.provider, modelId: model.id, name: model.name, reasoning,
      available: model.available, manualSelectionAllowed: model.manualSelectionAllowed, nativeChanges: false } };
  }

  async register(input) {
    if (!string(input.reviewToken, 80) || !Number.isSafeInteger(input.registryRevision) || input.registryRevision < 0) fail('INVALID','Review the exact local registration first.');
    if (this.registrationBusy) fail('BUSY','A local registration is already being saved.');
    const review = this.reviews.get(input.reviewToken);
    if (!review || review.expiresAt <= this.now()) fail('STALE','This registration review expired. Review the current model again.');
    if (input.registryRevision !== review.registryRevision || input.registryRevision !== this.document.revision) fail('CONFLICT','The local registry changed. Review the registration again.');
    this.assertOwner(review.owner);
    this.registrationBusy = true;
    try {
      await this.loadNative(true); this.assertOwner(review.owner);
      if (review.expiresAt <= this.now()) fail('STALE','This registration review expired. Review the current model again.');
      const view = this.overview(), model = view.catalog.models.find(item => item.modelRef === review.model.modelRef);
      if (!view.actions.canRegister || !model || this.logic.canonicalIdentity(model) !== review.signature) fail('STALE','The native model inventory changed. Review the current reference again.');
      if (input.registryRevision !== this.document.revision) fail('CONFLICT','The local registry changed. Review the registration again.');
      const registration = { id: crypto.randomUUID(), modelRef: model.modelRef, provider: model.provider, modelId: model.id,
        name: model.name, reasoning: review.reasoning, runtimeId: model.runtimeId, metadataFingerprint: model.metadataFingerprint, createdAt: this.now() };
      this.save({ ...this.document, revision: this.document.revision + 1, registrations: [...this.document.registrations, registration] });
      this.reviews.delete(input.reviewToken);
      return { registered: this.overview().registry.items.find(item => item.id === registration.id), registryRevision: this.document.revision };
    } finally { this.registrationBusy = false; }
  }
}
module.exports = { ModelManagerService, OPERATIONS };
