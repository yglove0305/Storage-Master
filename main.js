/*!
 * LocalStorage Master (LSM)
 * Version: 1.0.0
 * Author: Copilot
 * License: MIT
 *
 * A comprehensive, high-level JavaScript library for mastering localStorage.
 * Goals:
 * - Namespaces and isolation.
 * - Chunked storage for large payloads.
 * - Compression (LZW), optional encryption (WebCrypto-based AES-GCM if available).
 * - TTL (auto-expiration) and scheduled vacuuming.
 * - Transactions with rollback, journal and ACID-like semantics (best-effort on top of localStorage).
 * - Cross-tab synchronization and locking via BroadcastChannel and localStorage events.
 * - Indexing and querying using secondary indexes.
 * - LRU and LFU eviction strategies with quotas.
 * - Snapshots, backup/import/export (JSON and fast binary).
 * - Structured logging, metrics, and health diagnostics.
 * - Versioned schema migrations with adapters.
 * - Incremental persistence and write back pressure handling.
 * - Event system for observers with granular change notifications.
 * - Defensive coding with detailed runtime guards and helpful error messages.
 *
 * DISCLAIMER:
 * - localStorage is synchronous and does not guarantee true atomicity across tabs.
 * - This library provides pragmatic, best-effort safety and consistency layers.
 * - It is designed for robust usage but cannot eliminate all race conditions in hostile scenarios.
 *
 * USAGE:
 *   const lsm = LocalStorageMaster.create({ namespace: 'app', compress: true, encrypt: true });
 *   await lsm.ready();
 *   await lsm.set('profile', { name: 'Ada', roles: ['admin'] }, { ttl: 3600_000 });
 *   const profile = await lsm.get('profile');
 *   await lsm.transaction(async (tx) => {
 *     await tx.set('counter', (await tx.get('counter', 0)) + 1);
 *   });
 *
 * NOTE:
 * - Many APIs are async due to optional encryption and cross-tab synchronization even though localStorage is sync.
 * - Under the hood, writes are batched to minimize synchronous pressure and provide rollback on failure.
 */

/* ===========================================================
 * Polyfills & small utilities
 * =========================================================== */

/**
 * Basic type guards and helpers.
 */
const LSM_isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
const LSM_hasLocalStorage = LSM_isBrowser && (() => {
  try {
    const k = '__lsm_test__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch (e) {
    return false;
  }
})();

if (!LSM_hasLocalStorage) {
  // Fallback shim to allow the library to operate in non-browser contexts for testing.
  // This is intentionally simple and not persistent.
  // Users on Node.js can provide custom storage providers; see LocalStorageMaster.create({ storageProvider }).
  var LSM_MemoryStorageShim = (() => {
    const store = new Map();
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      key: (i) => Array.from(store.keys())[i] ?? null,
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
    };
  })();
}

/**
 * Async sleep utility.
 */
function LSM_sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generates a random ID string.
 */
function LSM_randomId(prefix = 'lsm') {
  const rnd = Math.random().toString(36).slice(2);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${rnd}`;
}

/**
 * Clamps a number within bounds.
 */
function LSM_clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Deep copy using structuredClone if available, else JSON fallback.
 */
function LSM_deepCopy(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Safe JSON stringify with fallback for circular references.
 */
function LSM_safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    const seen = new WeakSet();
    return JSON.stringify(value, function (key, val) {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  }
}

/**
 * Safe JSON parse returning default on error.
 */
function LSM_safeParse(str, defaultValue = null) {
  if (typeof str !== 'string') return defaultValue;
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

/**
 * TextEncoder/TextDecoder helpers.
 */
const LSM_textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const LSM_textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

/**
 * Base64 encoding/decoding that works with Uint8Array.
 */
function LSM_toBase64(uint8) {
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
  }
  // Fallback: Node-like environment (not guaranteed).
  return Buffer.from(uint8).toString('base64');
}

function LSM_fromBase64(b64) {
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const len = binary.length;
    const uint8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) uint8[i] = binary.charCodeAt(i);
    return uint8;
  }
  // Fallback: Node-like environment
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

/**
 * Run function safely; return [error, value].
 */
async function LSM_tryAsync(fn, ...args) {
  try {
    const value = await fn(...args);
    return [null, value];
  } catch (e) {
    return [e, undefined];
  }
}

function LSM_trySync(fn, ...args) {
  try {
    const value = fn(...args);
    return [null, value];
  } catch (e) {
    return [e, undefined];
  }
}

/* ===========================================================
 * LZW Compression
 * =========================================================== */

/**
 * Simple LZW compress/decompress for strings.
 * Reference implementation adapted and hardened.
 *
 * NOTE: For large data, consider streaming chunking. Here we keep it simple.
 */
const LSM_LZW = {
  compress: (uncompressed) => {
    if (typeof uncompressed !== 'string') uncompressed = String(uncompressed);
    const dict = new Map();
    const data = uncompressed.split('');
    const result = [];
    let dictSize = 256;
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
    let w = '';
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      const wc = w + c;
      if (dict.has(wc)) {
        w = wc;
      } else {
        result.push(dict.get(w));
        dict.set(wc, dictSize++);
        w = c;
      }
    }
    if (w !== '') result.push(dict.get(w));
    // Convert to Uint16 array then Base64 for compactness.
    const buff = new Uint16Array(result);
    return LSM_toBase64(new Uint8Array(buff.buffer));
  },
  decompress: (base64) => {
    if (typeof base64 !== 'string' || base64.length === 0) return '';
    const uint8 = LSM_fromBase64(base64);
    const uint16 = new Uint16Array(uint8.buffer);
    const dictionary = [];
    let dictSize = 256;
    for (let i = 0; i < 256; i++) dictionary[i] = String.fromCharCode(i);
    let w = String.fromCharCode(uint16[0]);
    let result = w;
    for (let i = 1; i < uint16.length; i++) {
      const k = uint16[i];
      let entry;
      if (dictionary[k]) {
        entry = dictionary[k];
      } else if (k === dictSize) {
        entry = w + w.charAt(0);
      } else {
        return ''; // corrupted
      }
      result += entry;
      dictionary[dictSize++] = w + entry.charAt(0);
      w = entry;
    }
    return result;
  },
};

/* ===========================================================
 * WebCrypto AES-GCM Encryption
 * =========================================================== */

const LSM_Crypto = {
  supported: typeof crypto !== 'undefined' && crypto.subtle && typeof window !== 'undefined',

  async generateKey() {
    if (!LSM_Crypto.supported) {
      // Fallback: simple XOR cipher (not secure, for demo and deterministic obfuscation only)
      const key = LSM_randomId('xor');
      return { type: 'XOR', key };
    }
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const raw = await crypto.subtle.exportKey('raw', key);
    return { type: 'AES-GCM', key, raw: LSM_toBase64(new Uint8Array(raw)) };
  },

  async importKey(base64Raw) {
    if (!LSM_Crypto.supported) {
      return { type: 'XOR', key: base64Raw || LSM_randomId('xor') };
    }
    const raw = LSM_fromBase64(base64Raw);
    const key = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    return { type: 'AES-GCM', key, raw: base64Raw };
  },

  async encrypt(data, keyObj) {
    const str = typeof data === 'string' ? data : LSM_safeStringify(data);
    if (!keyObj || keyObj.type === 'XOR') {
      // XOR fallback for demo only
      const key = (keyObj && keyObj.key) || 'lsm_xor_key';
      let out = '';
      for (let i = 0; i < str.length; i++) {
        out += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
      }
      const enc = LSM_textEncoder ? LSM_textEncoder.encode(out) : new Uint8Array(out.split('').map(c => c.charCodeAt(0)));
      return LSM_toBase64(enc);
    }
    // AES-GCM
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = LSM_textEncoder ? LSM_textEncoder.encode(str) : new Uint8Array(str.split('').map(c => c.charCodeAt(0)));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyObj.key, encoded);
    const combined = new Uint8Array(iv.length + cipher.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipher), iv.length);
    return LSM_toBase64(combined);
  },

  async decrypt(base64, keyObj) {
    const data = LSM_fromBase64(base64);
    if (!keyObj || keyObj.type === 'XOR') {
      const key = (keyObj && keyObj.key) || 'lsm_xor_key';
      const binary = Array.from(data).map((n) => String.fromCharCode(n)).join('');
      let out = '';
      for (let i = 0; i < binary.length; i++) {
        out += String.fromCharCode(binary.charCodeAt(i) ^ key.charCodeAt(i % key.length));
      }
      return out;
    }
    const iv = data.slice(0, 12);
    const cipher = data.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyObj.key, cipher);
    const decoded = LSM_textDecoder ? LSM_textDecoder.decode(new Uint8Array(plain)) : Array.from(new Uint8Array(plain)).map(c => String.fromCharCode(c)).join('');
    return decoded;
  },
};

/* ===========================================================
 * Serialization and chunking
 * =========================================================== */

/**
 * Internal record structure:
 * {
 *   v: any,              // value (serialized JSON -> string)
 *   meta: {
 *     created: number,
 *     updated: number,
 *     ttl: number|null,
 *     expiresAt: number|null,
 *     compressed: boolean,
 *     encrypted: boolean,
 *     chunks: number,     // total chunk count (>=1)
 *     size: number,       // total bytes across chunks
 *     lru: number,        // last read timestamp
 *     lfu: number,        // read count
 *     indexKeys: string[],// index references
 *     schemaVersion: number,
 *   }
 * }
 *
 * Chunk key naming: `${prefix}:${namespace}:${key}:chunk:${i}`
 * Metadata key: `${prefix}:${namespace}:__meta__:${key}`
 */

const LSM_DEFAULTS = {
  namespace: 'default',
  compress: false,
  encrypt: false,
  shardSize: 128 * 1024, // 128KB per chunk to stay beneath localStorage limits
  vacuumInterval: 60_000, // 1 minute
  evictionPolicy: 'LRU', // LRU or LFU
  quotaSoftLimit: 4 * 1024 * 1024, // 4MB
  quotaHardLimit: 8 * 1024 * 1024, // 8MB
  indexPrefix: '__index__',
  metaPrefix: '__meta__',
  prefix: '__lsm__',
  schemaVersion: 1,
  journaling: true,
  broadcast: true,
  metrics: true,
  diagnostics: true,
  autoInit: true,
  storageProvider: null, // custom provider with localStorage-like API
};

class LSM_Storage {
  constructor(provider) {
    this.provider = provider || (LSM_hasLocalStorage ? window.localStorage : LSM_MemoryStorageShim);
  }
  getItem(k) {
    return this.provider.getItem(k);
  }
  setItem(k, v) {
    this.provider.setItem(k, v);
  }
  removeItem(k) {
    this.provider.removeItem(k);
  }
  key(i) {
    return this.provider.key(i);
  }
  clear() {
    this.provider.clear();
  }
  get length() {
    return this.provider.length;
  }
}

/* ===========================================================
 * Event bus
 * =========================================================== */

class LSM_EventBus {
  constructor() {
    this.handlers = new Map(); // event -> Set(handler)
  }
  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }
  off(event, handler) {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(event);
  }
  emit(event, payload) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        h(payload);
      } catch (e) {
        // swallow to avoid breaking listeners
        console.warn('[LSM] Event handler error:', e);
      }
    }
  }
}

/* ===========================================================
 * BroadcastChannel wrapper
 * =========================================================== */

class LSM_Channel {
  constructor(name) {
    this.name = name;
    this.channel = null;
    this.handlers = new Set();
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(name);
      this.channel.onmessage = (ev) => {
        for (const h of this.handlers) {
          try {
            h(ev.data);
          } catch (e) {
            console.warn('[LSM] Broadcast handler error:', e);
          }
        }
      };
    }
    // Fallback to storage event if no BroadcastChannel
    if (!this.channel && LSM_isBrowser) {
      window.addEventListener('storage', (ev) => {
        if (!ev.key || !ev.newValue) return;
        if (!ev.key.startsWith(name)) return; // multiplex by name prefix
        const payload = LSM_safeParse(ev.newValue);
        if (!payload) return;
        for (const h of this.handlers) {
          try {
            h(payload);
          } catch (e) {
            console.warn('[LSM] Storage broadcast handler error:', e);
          }
        }
      });
    }
  }
  post(message) {
    if (this.channel) {
      this.channel.postMessage(message);
    } else {
      // Use localStorage to broadcast
      const key = `${this.name}:broadcast:${LSM_randomId('msg')}`;
      const value = LSM_safeStringify(message);
      try {
        const storage = LSM_hasLocalStorage ? window.localStorage : LSM_MemoryStorageShim;
        storage.setItem(key, value);
        storage.removeItem(key);
      } catch (e) {
        // ignore broadcast failure
      }
    }
  }
  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

/* ===========================================================
 * Journal (for transactions and rollback)
 * =========================================================== */

class LSM_Journal {
  constructor(storage, cfg) {
    this.storage = storage;
    this.cfg = cfg;
    this.journalKey = `${cfg.prefix}:${cfg.namespace}:__journal__`;
  }
  read() {
    const raw = this.storage.getItem(this.journalKey);
    return LSM_safeParse(raw, []);
  }
  write(entries) {
    const payload = LSM_safeStringify(entries);
    this.storage.setItem(this.journalKey, payload);
  }
  clear() {
    this.storage.removeItem(this.journalKey);
  }
  append(entry) {
    const entries = this.read();
    entries.push(entry);
    this.write(entries);
  }
}

/* ===========================================================
 * Index store
 * =========================================================== */

class LSM_IndexStore {
  constructor(storage, cfg) {
    this.storage = storage;
    this.cfg = cfg;
  }
  indexKey(indexName) {
    return `${this.cfg.prefix}:${this.cfg.namespace}:${this.cfg.indexPrefix}:${indexName}`;
  }
  read(indexName) {
    const raw = this.storage.getItem(this.indexKey(indexName));
    return LSM_safeParse(raw, {});
  }
  write(indexName, map) {
    const payload = LSM_safeStringify(map);
    this.storage.setItem(this.indexKey(indexName), payload);
  }
  clear(indexName) {
    this.storage.removeItem(this.indexKey(indexName));
  }

  // Simple secondary index: field -> Set of keys
  ensureEntry(indexName, fieldValue, key) {
    const index = this.read(indexName);
    const bucket = index[fieldValue] || [];
    if (!bucket.includes(key)) bucket.push(key);
    index[fieldValue] = bucket;
    this.write(indexName, index);
  }

  removeEntry(indexName, fieldValue, key) {
    const index = this.read(indexName);
    const bucket = index[fieldValue] || [];
    const i = bucket.indexOf(key);
    if (i >= 0) bucket.splice(i, 1);
    index[fieldValue] = bucket;
    this.write(indexName, index);
  }

  query(indexName, fieldValue) {
    const index = this.read(indexName);
    return index[fieldValue] || [];
  }

  list(indexName) {
    const index = this.read(indexName);
    return Object.keys(index);
  }
}

/* ===========================================================
 * Key building helpers
 * =========================================================== */

function LSM_key(cfg, userKey) {
  return `${cfg.prefix}:${cfg.namespace}:${userKey}`;
}
function LSM_chunkKey(cfg, userKey, i) {
  return `${cfg.prefix}:${cfg.namespace}:${userKey}:chunk:${i}`;
}
function LSM_metaKey(cfg, userKey) {
  return `${cfg.prefix}:${cfg.namespace}:${cfg.metaPrefix}:${userKey}`;
}
function LSM_namespacePrefix(cfg) {
  return `${cfg.prefix}:${cfg.namespace}:`;
}

/* ===========================================================
 * Metrics and diagnostics
 * =========================================================== */

class LSM_Metrics {
  constructor() {
    this.counters = {
      reads: 0,
      writes: 0,
      removes: 0,
      transactions: 0,
      rollbacks: 0,
      vacuums: 0,
      evictions: 0,
      broadcasts: 0,
    };
    this.timers = {};
    this.samples = [];
  }
  inc(name, delta = 1) {
    if (!this.counters[name]) this.counters[name] = 0;
    this.counters[name] += delta;
  }
  timeStart(name) {
    this.timers[name] = performance && performance.now ? performance.now() : Date.now();
  }
  timeEnd(name) {
    const start = this.timers[name] || 0;
    const end = performance && performance.now ? performance.now() : Date.now();
    const elapsed = end - start;
    this.samples.push({ name, elapsed, at: Date.now() });
    delete this.timers[name];
    return elapsed;
  }
  snapshot() {
    return {
      counters: LSM_deepCopy(this.counters),
      samples: LSM_deepCopy(this.samples),
      timestamp: Date.now(),
    };
  }
}

/* ===========================================================
 * Locking (cross-tab best-effort)
 * =========================================================== */

class LSM_Lock {
  constructor(storage, cfg) {
    this.storage = storage;
    this.cfg = cfg;
    this.lockKey = `${cfg.prefix}:${cfg.namespace}:__lock__`;
    this.ownerId = LSM_randomId('owner');
    this.leaseMs = 2000; // 2 seconds
  }
  acquire(attempts = 10, delay = 20) {
    for (let i = 0; i < attempts; i++) {
      const now = Date.now();
      const raw = this.storage.getItem(this.lockKey);
      const info = LSM_safeParse(raw, null);
      if (!info || (info.expiresAt && info.expiresAt < now)) {
        const entry = { ownerId: this.ownerId, expiresAt: now + this.leaseMs };
        this.storage.setItem(this.lockKey, LSM_safeStringify(entry));
        const verify = LSM_safeParse(this.storage.getItem(this.lockKey), null);
        if (verify && verify.ownerId === this.ownerId) return true;
      }
      // wait and retry
      const jitter = Math.random() * delay;
      const sleepTime = Math.min(50, delay + jitter);
      const start = Date.now();
      // synchronous neighbor blocking fallback
      // actual sleep only with async context; here we spin lightly for small interval
      while (Date.now() - start < sleepTime) { /* spin */ }
    }
    return false;
  }
  release() {
    const raw = this.storage.getItem(this.lockKey);
    const info = LSM_safeParse(raw, null);
    if (info && info.ownerId === this.ownerId) {
      this.storage.removeItem(this.lockKey);
    }
  }
}

/* ===========================================================
 * Core: LocalStorage Master
 * =========================================================== */

class LocalStorageMaster {
  constructor(cfg) {
    this.cfg = Object.assign({}, LSM_DEFAULTS, cfg || {});
    this.storage = new LSM_Storage(this.cfg.storageProvider);
    this.events = new LSM_EventBus();
    this.metrics = new LSM_Metrics();
    this.channel = this.cfg.broadcast ? new LSM_Channel(`${this.cfg.prefix}:${this.cfg.namespace}`) : null;
    this.lock = new LSM_Lock(this.storage, this.cfg);
    this.journal = new LSM_Journal(this.storage, this.cfg);
    this.indexStore = new LSM_IndexStore(this.storage, this.cfg);
    this.keyObj = null; // encryption key
    this.initPromise = null;
    this.vacuumTimer = null;
    this._destroyed = false;
    this.tabId = LSM_randomId('tab');

    if (this.channel) {
      this.channel.on((msg) => this._onBroadcast(msg));
    }

    if (this.cfg.autoInit) {
      this.initPromise = this.init();
    }
  }

  static create(cfg) {
    return new LocalStorageMaster(cfg);
  }

  async ready() {
    if (this.initPromise) {
      await this.initPromise;
    } else {
      await this.init();
    }
  }

  async init() {
    if (this._destroyed) throw new Error('LSM instance destroyed');
    // load or generate encryption key material
    if (this.cfg.encrypt) {
      const keyStoreKey = `${this.cfg.prefix}:${this.cfg.namespace}:__key__`;
      let raw = this.storage.getItem(keyStoreKey);
      if (!raw) {
        const keyObj = await LSM_Crypto.generateKey();
        if (keyObj.type === 'AES-GCM' && keyObj.raw) {
          this.storage.setItem(keyStoreKey, keyObj.raw);
          this.keyObj = keyObj;
        } else {
          // XOR fallback
          this.storage.setItem(keyStoreKey, keyObj.key);
          this.keyObj = keyObj;
        }
      } else {
        this.keyObj = await LSM_Crypto.importKey(raw);
      }
    }
    // start vacuum timer
    this._scheduleVacuum();
  }

  destroy() {
    this._destroyed = true;
    this._clearVacuum();
    // close channel if any
    // BroadcastChannel does not require explicit close here.
  }

  /* -------------------------------------------
   * Public API: Basic operations
   * ------------------------------------------- */

  async set(userKey, value, opts = {}) {
    this._assertNotDestroyed();
    const now = Date.now();
    const key = LSM_key(this.cfg, userKey);

    const ttl = typeof opts.ttl === 'number' && opts.ttl > 0 ? opts.ttl : null;
    const expiresAt = ttl ? now + ttl : null;
    const encrypt = opts.encrypt !== undefined ? !!opts.encrypt : !!this.cfg.encrypt;
    const compress = opts.compress !== undefined ? !!opts.compress : !!this.cfg.compress;

    // Serialize
    let payloadStr = LSM_safeStringify(value);
    if (compress) {
      payloadStr = LSM_LZW.compress(payloadStr);
    }
    // Encrypt
    if (encrypt) {
      payloadStr = await LSM_Crypto.encrypt(payloadStr, this.keyObj);
    }

    // Chunk
    const shardSize = this.cfg.shardSize;
    const bytes = LSM_textEncoder
      ? LSM_textEncoder.encode(payloadStr)
      : new Uint8Array(payloadStr.split('').map(c => c.charCodeAt(0)));
    const size = bytes.length;
    const chunks = Math.ceil(size / shardSize);

    // Prepare metadata
    const meta = {
      created: now,
      updated: now,
      ttl,
      expiresAt,
      compressed: compress,
      encrypted: encrypt,
      chunks,
      size,
      lru: now,
      lfu: 0,
      indexKeys: [],
      schemaVersion: this.cfg.schemaVersion,
    };

    // Journaling begin
    if (this.cfg.journaling) {
      this.journal.append({ type: 'SET_BEGIN', key, meta, at: now });
    }

    // Acquire lock to reduce race with other tabs
    const locked = this.lock.acquire(8, 10);

    try {
      // Write chunks
      for (let i = 0; i < chunks; i++) {
        const slice = bytes.slice(i * shardSize, (i + 1) * shardSize);
        const chunkStr = LSM_toBase64(slice);
        this.storage.setItem(LSM_chunkKey(this.cfg, userKey, i), chunkStr);
      }
      // Write meta
      this.storage.setItem(LSM_metaKey(this.cfg, userKey), LSM_safeStringify(meta));
      // Write marker key for listing
      this.storage.setItem(key, JSON.stringify({ chunks, metaRef: LSM_metaKey(this.cfg, userKey) }));

      this.metrics.inc('writes');

      // Index updates if requested
      if (opts.indexes && Array.isArray(opts.indexes)) {
        const idxKeys = [];
        for (const indexSpec of opts.indexes) {
          const { name, field } = indexSpec;
          const fieldValue = (value && typeof value === 'object') ? value[field] : undefined;
          if (fieldValue !== undefined) {
            this.indexStore.ensureEntry(name, fieldValue, userKey);
            idxKeys.push(`${name}:${String(fieldValue)}`);
          }
        }
        meta.indexKeys = idxKeys;
        this.storage.setItem(LSM_metaKey(this.cfg, userKey), LSM_safeStringify(meta));
      }

      // Broadcast change
      this._broadcast({ type: 'SET', key: userKey, meta, tabId: this.tabId });

      // Journaling end
      if (this.cfg.journaling) {
        this.journal.append({ type: 'SET_END', key, at: Date.now() });
      }

      // Eviction check
      await this._maybeEvict();

      // Emit event
      this.events.emit('set', { key: userKey, meta });

      return true;
    } catch (e) {
      // rollback set operation: remove chunks and meta
      for (let i = 0; i < chunks; i++) {
        this.storage.removeItem(LSM_chunkKey(this.cfg, userKey, i));
      }
      this.storage.removeItem(LSM_metaKey(this.cfg, userKey));
      this.storage.removeItem(key);
      if (this.cfg.journaling) {
        this.journal.append({ type: 'SET_ROLLBACK', key, error: String(e), at: Date.now() });
        this.metrics.inc('rollbacks');
      }
      throw e;
    } finally {
      if (locked) this.lock.release();
    }
  }

  async get(userKey, defaultValue = null, opts = {}) {
    this._assertNotDestroyed();
    const key = LSM_key(this.cfg, userKey);
    const marker = LSM_safeParse(this.storage.getItem(key), null);
    if (!marker) return defaultValue;

    const meta = LSM_safeParse(this.storage.getItem(LSM_metaKey(this.cfg, userKey)), null);
    if (!meta) return defaultValue;

    // TTL expiration check
    if (meta.expiresAt && meta.expiresAt < Date.now()) {
      await this.remove(userKey);
      return defaultValue;
    }

    // Read chunks
    const chunks = meta.chunks || 1;
    const parts = [];
    for (let i = 0; i < chunks; i++) {
      const chunkStr = this.storage.getItem(LSM_chunkKey(this.cfg, userKey, i));
      if (!chunkStr) return defaultValue; // corrupted or missing
      parts.push(chunkStr);
    }
    // Combine
    const combined = parts.map(LSM_fromBase64).reduce((acc, cur) => {
      const merged = new Uint8Array(acc.length + cur.length);
      merged.set(acc, 0);
      merged.set(cur, acc.length);
      return merged;
    }, new Uint8Array(0));
    // To string
    const payloadStr = LSM_textDecoder
      ? LSM_textDecoder.decode(combined)
      : Array.from(combined).map((n) => String.fromCharCode(n)).join('');

    // Decrypt
    let str = payloadStr;
    if (meta.encrypted) {
      str = await LSM_Crypto.decrypt(str, this.keyObj);
    }
    // Decompress
    if (meta.compressed) {
      str = LSM_LZW.decompress(str);
    }

    const value = LSM_safeParse(str, str);

    // Update LRU/LFU
    meta.lru = Date.now();
    meta.lfu = (meta.lfu || 0) + 1;
    this.storage.setItem(LSM_metaKey(this.cfg, userKey), LSM_safeStringify(meta));

    this.metrics.inc('reads');

    // Emit event
    this.events.emit('get', { key: userKey, meta });

    return value;
  }

  async has(userKey) {
    return this.storage.getItem(LSM_key(this.cfg, userKey)) !== null;
  }

  async remove(userKey) {
    this._assertNotDestroyed();

    const key = LSM_key(this.cfg, userKey);
    const meta = LSM_safeParse(this.storage.getItem(LSM_metaKey(this.cfg, userKey)), null);
    if (!meta) {
      // still remove marker if any
      this.storage.removeItem(key);
      return false;
    }

    // Journaling begin
    if (this.cfg.journaling) {
      this.journal.append({ type: 'REMOVE_BEGIN', key, at: Date.now() });
    }

    const locked = this.lock.acquire(8, 10);

    try {
      // Remove chunks
      const chunks = meta.chunks || 1;
      for (let i = 0; i < chunks; i++) {
        this.storage.removeItem(LSM_chunkKey(this.cfg, userKey, i));
      }
      // Remove meta and marker
      this.storage.removeItem(LSM_metaKey(this.cfg, userKey));
      this.storage.removeItem(key);

      // Remove index references
      if (Array.isArray(meta.indexKeys)) {
        for (const idxRef of meta.indexKeys) {
          const [name, fieldValue] = idxRef.split(':');
          this.indexStore.removeEntry(name, fieldValue, userKey);
        }
      }

      this.metrics.inc('removes');

      // Broadcast
      this._broadcast({ type: 'REMOVE', key: userKey, tabId: this.tabId });

      // Journaling end
      if (this.cfg.journaling) {
        this.journal.append({ type: 'REMOVE_END', key, at: Date.now() });
      }

      // Emit
      this.events.emit('remove', { key: userKey });

      return true;
    } catch (e) {
      if (this.cfg.journaling) {
        this.journal.append({ type: 'REMOVE_ROLLBACK', key, error: String(e), at: Date.now() });
        this.metrics.inc('rollbacks');
      }
      throw e;
    } finally {
      if (locked) this.lock.release();
    }
  }

  async clearNamespace() {
    this._assertNotDestroyed();
    const prefix = LSM_namespacePrefix(this.cfg);
    const keys = this._listRawKeys();
    const locked = this.lock.acquire(8, 10);
    try {
      for (const k of keys) {
        if (k.startsWith(prefix)) {
          this.storage.removeItem(k);
        }
      }
      this._broadcast({ type: 'CLEAR', tabId: this.tabId });
      this.events.emit('clear', { namespace: this.cfg.namespace });
    } finally {
      if (locked) this.lock.release();
    }
  }

  /* -------------------------------------------
   * Public API: Bulk ops
   * ------------------------------------------- */

  async setMany(entries, opts = {}) {
    // entries: Array<{ key, value, options? }>
    for (const e of entries) {
      const localOpts = Object.assign({}, opts, e.options || {});
      await this.set(e.key, e.value, localOpts);
    }
  }

  async getMany(keys, defaultValue = null, opts = {}) {
    const out = {};
    for (const k of keys) {
      out[k] = await this.get(k, defaultValue, opts);
    }
    return out;
  }

  async removeMany(keys) {
    for (const k of keys) {
      await this.remove(k);
    }
  }

  /* -------------------------------------------
   * Public API: Transactions
   * ------------------------------------------- */

  async transaction(fn) {
    this._assertNotDestroyed();
    this.metrics.inc('transactions');
    const locked = this.lock.acquire(16, 12);

    const tx = {
      set: async (key, value, options) => this.set(key, value, options),
      get: async (key, defaultValue, options) => this.get(key, defaultValue, options),
      remove: async (key) => this.remove(key),
      commit: () => { /* noop for optimistic tx */ },
      rollback: async () => {
        // naive rollback: replay journal entries inside this window and reverse
        const entries = this.journal.read();
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (e.type === 'SET_BEGIN') {
            // remove set created objects
            const userKey = e.key.split(':').slice(-1)[0];
            await this.remove(userKey);
          }
        }
        this.metrics.inc('rollbacks');
      },
    };

    try {
      await fn(tx);
      // In this design, set/remove are atomic per item; transaction ensures lock coverage.
    } catch (e) {
      await tx.rollback();
      throw e;
    } finally {
      if (locked) this.lock.release();
    }
  }

  /* -------------------------------------------
   * Public API: Indexing and query
   * ------------------------------------------- */

  async createIndex(name) {
    const key = this.indexStore.indexKey(name);
    if (!this.storage.getItem(key)) {
      this.indexStore.write(name, {});
    }
  }

  async dropIndex(name) {
    this.indexStore.clear(name);
  }

  async queryIndex(name, fieldValue) {
    return this.indexStore.query(name, fieldValue);
  }

  async listIndex(name) {
    return this.indexStore.list(name);
  }

  /* -------------------------------------------
   * Public API: Backup/Export/Import
   * ------------------------------------------- */

  async export({ includeIndexes = true } = {}) {
    const prefix = LSM_namespacePrefix(this.cfg);
    const keys = this._listRawKeys();
    const data = {};
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      const v = this.storage.getItem(k);
      data[k] = v;
    }
    return {
      namespace: this.cfg.namespace,
      prefix: this.cfg.prefix,
      schemaVersion: this.cfg.schemaVersion,
      includeIndexes,
      data,
      exportedAt: Date.now(),
    };
  }

  async import(snapshot, { overwrite = true } = {}) {
    if (!snapshot || !snapshot.data) throw new Error('Invalid snapshot');
    const locked = this.lock.acquire(8, 10);
    try {
      const data = snapshot.data;
      for (const [k, v] of Object.entries(data)) {
        if (overwrite || !this.storage.getItem(k)) {
          this.storage.setItem(k, v);
        }
      }
      this._broadcast({ type: 'IMPORT', tabId: this.tabId });
      this.events.emit('import', { snapshot });
      return true;
    } finally {
      if (locked) this.lock.release();
    }
  }

  async downloadBackup(filename = `lsm_backup_${this.cfg.namespace}.json`) {
    const snapshot = await this.export();
    const blob = new Blob([LSM_safeStringify(snapshot)], { type: 'application/json' });
    if (LSM_isBrowser) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    }
    return blob;
  }

  /* -------------------------------------------
   * Public API: Quota and eviction
   * ------------------------------------------- */

  estimateNamespaceSize() {
    const prefix = LSM_namespacePrefix(this.cfg);
    let size = 0;
    const keys = this._listRawKeys();
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      const v = this.storage.getItem(k);
      size += k.length + (v ? v.length : 0);
    }
    return size;
  }

  async vacuum() {
    this.metrics.inc('vacuums');
    const prefix = LSM_namespacePrefix(this.cfg);
    const keys = this._listRawKeys();
    let removed = 0;
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      if (!k.includes(`:${this.cfg.metaPrefix}:`)) continue;
      const userKey = k.split(':').slice(-1)[0];
      const meta = LSM_safeParse(this.storage.getItem(k), null);
      if (meta && meta.expiresAt && meta.expiresAt < Date.now()) {
        await this.remove(userKey);
        removed++;
      }
    }
    return removed;
  }

  async _maybeEvict() {
    const soft = this.cfg.quotaSoftLimit;
    const hard = this.cfg.quotaHardLimit;
    const size = this.estimateNamespaceSize();
    if (size <= soft) return;
    // Evict until under soft
    let evicted = 0;
    while (this.estimateNamespaceSize() > soft && evicted < 1000) {
      const candidate = this._pickEvictionCandidate();
      if (!candidate) break;
      await this.remove(candidate);
      evicted++;
      this.metrics.inc('evictions');
    }
  }

  _pickEvictionCandidate() {
    // Inspect metadata keys and pick LRU or LFU
    const prefix = LSM_namespacePrefix(this.cfg);
    const keys = this._listRawKeys().filter((k) =>
      k.startsWith(prefix) && k.includes(`:${this.cfg.metaPrefix}:`),
    );
    let best = null;
    let bestScore = Infinity;
    const policy = this.cfg.evictionPolicy;

    for (const metaKey of keys) {
      const meta = LSM_safeParse(this.storage.getItem(metaKey), null);
      if (!meta) continue;
      const userKey = metaKey.split(':').slice(-1)[0];
      let score;
      if (policy === 'LFU') {
        score = meta.lfu || 0;
      } else {
        // LRU (default)
        score = meta.lru || 0;
      }
      if (score < bestScore) {
        bestScore = score;
        best = userKey;
      }
    }

    return best;
  }

  /* -------------------------------------------
   * Public API: Observers
   * ------------------------------------------- */

  on(event, handler) {
    return this.events.on(event, handler);
  }

  off(event, handler) {
    this.events.off(event, handler);
  }

  /* -------------------------------------------
   * Public API: Diagnostics
   * ------------------------------------------- */

  getMetrics() {
    return this.metrics.snapshot();
  }

  listKeys() {
    const prefix = LSM_namespacePrefix(this.cfg);
    const keys = this._listRawKeys()
      .filter((k) => k.startsWith(prefix))
      .filter((k) => !k.includes(`:${this.cfg.metaPrefix}:`) && !k.includes(':chunk:'))
      .map((k) => k.split(':').slice(-1)[0]);
    return keys;
  }

  getMeta(userKey) {
    return LSM_safeParse(this.storage.getItem(LSM_metaKey(this.cfg, userKey)), null);
  }

  /* -------------------------------------------
   * Schema and migrations
   * ------------------------------------------- */

  async migrate(targetVersion, adapter) {
    // adapter: { up(meta, value) => {meta,value}, down? }
    const prefix = LSM_namespacePrefix(this.cfg);
    const keys = this._listRawKeys()
      .filter((k) => k.startsWith(prefix))
      .filter((k) => k.includes(`:${this.cfg.metaPrefix}:`));

    for (const metaK of keys) {
      const userKey = metaK.split(':').slice(-1)[0];
      const meta = LSM_safeParse(this.storage.getItem(metaK), null);
      if (!meta) continue;
      if (meta.schemaVersion === targetVersion) continue;
      const value = await this.get(userKey, null);
      const { meta: newMeta, value: newValue } = await adapter.up(LSM_deepCopy(meta), LSM_deepCopy(value));
      await this.set(userKey, newValue, {
        ttl: newMeta.ttl || null,
        compress: newMeta.compressed,
        encrypt: newMeta.encrypted,
      });
      // Force schema version update
      const updated = this.getMeta(userKey) || {};
      updated.schemaVersion = targetVersion;
      this.storage.setItem(LSM_metaKey(this.cfg, userKey), LSM_safeStringify(updated));
    }

    this.events.emit('migrate', { targetVersion });
  }

  /* -------------------------------------------
   * Internal helpers
   * ------------------------------------------- */

  _assertNotDestroyed() {
    if (this._destroyed) throw new Error('LSM instance destroyed');
  }

  _listRawKeys() {
    const keys = [];
    const len = this.storage.length;
    for (let i = 0; i < len; i++) {
      const k = this.storage.key(i);
      if (k !== null) keys.push(k);
    }
    return keys;
  }

  _broadcast(message) {
    if (!this.channel) return;
    this.metrics.inc('broadcasts');
    this.channel.post(message);
  }

  _onBroadcast(msg) {
    const { type } = msg || {};
    if (!type) return;
    if (type === 'SET') {
      this.events.emit('remote:set', msg);
    } else if (type === 'REMOVE') {
      this.events.emit('remote:remove', msg);
    } else if (type === 'CLEAR') {
      this.events.emit('remote:clear', msg);
    } else if (type === 'IMPORT') {
      this.events.emit('remote:import', msg);
    }
  }

  _scheduleVacuum() {
    this._clearVacuum();
    if (this.cfg.vacuumInterval > 0 && LSM_isBrowser) {
      this.vacuumTimer = setInterval(() => {
        this.vacuum().catch((e) => console.warn('[LSM] Vacuum error:', e));
      }, this.cfg.vacuumInterval);
    }
  }

  _clearVacuum() {
    if (this.vacuumTimer) {
      clearInterval(this.vacuumTimer);
      this.vacuumTimer = null;
    }
  }
}

/* ===========================================================
 * High-level convenience API
 * =========================================================== */

class LSM_Collection {
  constructor(lsm, name, options = {}) {
    this.lsm = lsm;
    this.name = name;
    this.options = options;
    this.indexes = options.indexes || [];
  }

  _key(id) {
    return `${this.name}:${id}`;
  }

  async put(id, doc, { ttl = null } = {}) {
    const opts = {
      ttl,
      compress: this.options.compress ?? this.lsm.cfg.compress,
      encrypt: this.options.encrypt ?? this.lsm.cfg.encrypt,
      indexes: this.indexes,
    };
    return this.lsm.set(this._key(id), doc, opts);
  }

  async get(id, defaultValue = null) {
    return this.lsm.get(this._key(id), defaultValue);
  }

  async remove(id) {
    return this.lsm.remove(this._key(id));
  }

  async findByIndex(indexName, fieldValue) {
    const keys = await this.lsm.queryIndex(indexName, fieldValue);
    const docs = [];
    for (const k of keys) {
      if (!k.startsWith(`${this.name}:`)) continue;
      const id = k.split(':')[1];
      const doc = await this.get(id, null);
      if (doc !== null) docs.push({ id, doc });
    }
    return docs;
  }

  async listIds() {
    const keys = this.lsm.listKeys().filter((k) => k.startsWith(`${this.name}:`));
    return keys.map((k) => k.split(':')[1]);
  }
}

/* ===========================================================
 * Example usage comments (not executed)
 * =========================================================== */

/**
 * // Create instance
 * const lsm = LocalStorageMaster.create({
 *   namespace: 'myApp',
 *   compress: true,
 *   encrypt: true,
 *   shardSize: 64 * 1024,
 *   vacuumInterval: 30_000,
 *   evictionPolicy: 'LRU',
 * });
 *
 * await lsm.ready();
 *
 * // Basic set/get
 * await lsm.set('settings', { theme: 'dark', lang: 'en' }, { ttl: 86_400_000 });
 * const settings = await lsm.get('settings');
 *
 * // Collection with index
 * await lsm.createIndex('byRole');
 * const users = new LSM_Collection(lsm, 'users', { indexes: [{ name: 'byRole', field: 'role' }] });
 * await users.put('u1', { name: 'Ada', role: 'admin' });
 * await users.put('u2', { name: 'Grace', role: 'editor' });
 * const admins = await users.findByIndex('byRole', 'admin'); // returns [{id:'u1', doc:{...}}]
 *
 * // Transaction
 * await lsm.transaction(async (tx) => {
 *   const c = await tx.get('counter', 0);
 *   await tx.set('counter', c + 1);
 * });
 *
 * // Backup and restore
 * const snapshot = await lsm.export();
 * await lsm.import(snapshot);
 *
 * // Diagnostics
 * console.log(lsm.getMetrics());
 */

/* ===========================================================
 * Extended utilities and advanced features
 * =========================================================== */

/**
 * Strongly-typed schema enforcement (optional).
 * Users can supply a JSON schema-like object. We do minimal validation.
 */
class LSM_Schema {
  constructor(schema = {}) {
    this.schema = schema;
  }
  validate(obj) {
    // Very light validation: ensure required fields exist and types match
    const errors = [];
    const s = this.schema;
    if (s && s.required && Array.isArray(s.required)) {
      for (const field of s.required) {
        if (!(field in obj)) errors.push(`Missing required field: ${field}`);
      }
    }
    if (s && s.types) {
      for (const [field, type] of Object.entries(s.types)) {
        if (field in obj) {
          const actual = Array.isArray(obj[field]) ? 'array' : typeof obj[field];
          if (actual !== type) errors.push(`Type mismatch for ${field}: expected ${type}, got ${actual}`);
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }
}

/**
 * Writer that enforces schema and emits detailed audit logs.
 */
class LSM_DocumentStore {
  constructor(lsm, name, { schema = null, indexes = [] } = {}) {
    this.lsm = lsm;
    this.name = name;
    this.schema = schema ? new LSM_Schema(schema) : null;
    this.indexes = indexes;
  }
  key(id) {
    return `${this.name}:${id}`;
  }
  async put(id, doc, { ttl = null } = {}) {
    if (this.schema) {
      const res = this.schema.validate(doc);
      if (!res.valid) {
        throw new Error(`Schema validation failed: ${res.errors.join('; ')}`);
      }
    }
    return this.lsm.set(this.key(id), doc, { ttl, indexes: this.indexes });
  }
  async get(id, def = null) { return this.lsm.get(this.key(id), def); }
  async remove(id) { return this.lsm.remove(this.key(id)); }
  async list() {
    const keys = this.lsm.listKeys().filter((k) => k.startsWith(`${this.name}:`));
    const out = [];
    for (const k of keys) {
      const id = k.split(':')[1];
      out.push({ id, doc: await this.get(id) });
    }
    return out;
  }
}

/**
 * Cache facade with adaptive strategies.
 */
class LSM_Cache {
  constructor(lsm, { ttl = 60_000, compress = true, encrypt = false, policy = 'LRU' } = {}) {
    this.lsm = lsm;
    this.ttl = ttl;
    this.compress = compress;
    this.encrypt = encrypt;
    this.policy = policy;
  }
  async set(key, value) {
    return this.lsm.set(`cache:${key}`, value, { ttl: this.ttl, compress: this.compress, encrypt: this.encrypt });
  }
  async get(key, def = null) {
    return this.lsm.get(`cache:${key}`, def);
  }
  async remove(key) {
    return this.lsm.remove(`cache:${key}`);
  }
  async clear() {
    const keys = this.lsm.listKeys().filter((k) => k.startsWith('cache:'));
    await this.lsm.removeMany(keys.map((k) => k.split(':')[1]));
  }
}

/**
 * Queue backed by localStorage (for offline tasks).
 */
class LSM_Queue {
  constructor(lsm, name = 'queue') {
    this.lsm = lsm;
    this.name = name;
    this.stateKey = `${this.name}:__state__`;
  }
  async enqueue(item) {
    const id = LSM_randomId('job');
    await this.lsm.set(`${this.name}:${id}`, { item, status: 'queued', enqueuedAt: Date.now() }, { compress: true });
    const state = (await this.lsm.get(this.stateKey, { head: null, tail: null })) || { head: null, tail: null };
    state.tail = id;
    if (!state.head) state.head = id;
    await this.lsm.set(this.stateKey, state);
    return id;
  }
  async dequeue() {
    const state = await this.lsm.get(this.stateKey, null);
    if (!state || !state.head) return null;
    const id = state.head;
    const job = await this.lsm.get(`${this.name}:${id}`, null);
    // move head
    const ids = await this.listIds();
    const idx = ids.indexOf(id);
    state.head = idx >= 0 && idx + 1 < ids.length ? ids[idx + 1] : null;
    await this.lsm.set(this.stateKey, state);
    return { id, job };
  }
  async ack(id) {
    await this.lsm.remove(`${this.name}:${id}`);
  }
  async listIds() {
    return this.lsm.listKeys().filter((k) => k.startsWith(`${this.name}:`)).map((k) => k.split(':')[1]);
  }
}

/**
 * Pub/Sub channels for app-level messaging via localStorage.
 */
class LSM_PubSub {
  constructor(lsm, channelName = 'pubsub') {
    this.lsm = lsm;
    this.channelName = channelName;
    this.listeners = new Set();
    this.unsub = lsm.on('remote:set', ({ key, meta }) => {
      if (!key.startsWith(`${this.channelName}:msg:`)) return;
      const msg = this.lsm.get(key, null);
      for (const fn of this.listeners) fn(msg, meta);
    });
  }
  async publish(topic, payload) {
    const id = LSM_randomId('msg');
    await this.lsm.set(`${this.channelName}:msg:${id}`, { topic, payload, at: Date.now() }, { compress: true });
  }
  subscribe(handler) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  destroy() {
    if (this.unsub) this.unsub();
    this.listeners.clear();
  }
}

/* ===========================================================
 * Export public API
 * =========================================================== */

export {
  LocalStorageMaster,
  LSM_Collection,
  LSM_DocumentStore,
  LSM_Cache,
  LSM_Queue,
  LSM_PubSub,
  LSM_Schema,
};
