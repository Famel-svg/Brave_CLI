import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadOptionsPage(nativeMessagingResult, savedToken = 'a'.repeat(32), stateOverrides = {}) {
  const elements = new Map();
  const timers = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const statusState = {
    nativeHostState: 'unavailable',
    tokenMismatch: true,
    authenticated: false,
    bridgeConnected: false,
    workerBuild: '0.1.6',
    tokenSource: 'extension_storage',
    ...stateOverrides,
  };
  let reloadCount = 0;
  let storageWriteCount = 0;
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async message => {
        if (message.type === 'ui.status') return statusState;
        if (message.type === 'ui.diagnostics') return { entries: [] };
        return { ok: true };
      },
      sendNativeMessage: async () => {
        if (nativeMessagingResult instanceof Error) throw nativeMessagingResult;
        return nativeMessagingResult;
      },
      reload: () => { reloadCount += 1; },
    },
    storage: { local: {
      get: async () => ({ bridgeToken: savedToken }),
      set: async () => { storageWriteCount += 1; },
    } },
  };
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        const listeners = new Map();
        elements.set(selector, {
          addEventListener: (name, handler) => listeners.set(name, handler),
          setAttribute(name, value) { this[name] = value; },
          textContent: '', value: '', files: [], type: selector === '#token' ? 'password' : '', disabled: false,
          click(name = 'click') { listeners.get(name)?.(); },
        });
      }
      return elements.get(selector);
    },
    addEventListener: (name, handler) => documentListeners.set(name, handler),
    visibilityState: 'visible',
    createElement() { return { click() {}, set href(_value) {}, set download(_value) {} }; },
  };
  let source = await readFile(new URL('../extension/options.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*\n/, '');
  const run = `(async () => { ${source}\n})()`;
  await vm.runInNewContext(run, {
    chrome,
    document,
    normalizeBridgeToken: value => value,
    tokensMatchByFingerprint: async () => false,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout: () => undefined,
    window: { addEventListener: (name, handler) => windowListeners.set(name, handler) },
    Blob: class {},
    URL: { createObjectURL: () => '', revokeObjectURL() {} },
    Date,
    JSON,
    String,
    Boolean,
    Promise,
  });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  return {
    elements, timers, document, documentListeners, windowListeners,
    get reloadCount() { return reloadCount; },
    get storageWriteCount() { return storageWriteCount; },
  };
}

test('settings page probes native host then schedules extension worker reload', async () => {
  const state = await loadOptionsPage({ ok: true, token: 'a'.repeat(32) });
  assert.match(state.elements.get('#status').textContent, /Restarting extension worker/);
  const reload = state.timers.find(timer => timer.delay === 250);
  assert.ok(reload, 'successful probe should schedule reload');
  reload.callback();
  assert.equal(state.reloadCount, 1);
});

test('settings page shows native host startup error without reloading', async () => {
  const state = await loadOptionsPage(new Error('Specified native messaging host not found'));
  assert.match(state.elements.get('#status').textContent, /host not found/);
  assert.equal(state.reloadCount, 0);
  assert.equal(state.timers.some(timer => timer.delay === 250), false);
});

test('settings page retries native host when connected state still uses stale storage token', async () => {
  const state = await loadOptionsPage(
    { ok: true, token: 'b'.repeat(32) },
    'a'.repeat(32),
    { nativeHostState: 'connected', tokenMismatch: true, tokenSource: 'extension_storage' },
  );
  assert.match(state.elements.get('#status').textContent, /Restarting extension worker/);
  assert.ok(state.timers.some(timer => timer.delay === 250));
});

test('settings page blocks manual token save while native host is starting', async () => {
  const state = await loadOptionsPage(
    { ok: true, token: 'b'.repeat(32) },
    'a'.repeat(32),
    { nativeHostState: 'starting', tokenMismatch: false },
  );
  const input = state.elements.get('#token');
  input.value = 'c'.repeat(32);
  state.elements.get('#save').click();
  await new Promise(resolve => setImmediate(resolve));

  assert.match(state.elements.get('#status').textContent, /Native host is loading its token/);
  assert.equal(state.storageWriteCount, 0);
});

test('saved token reveal hides automatically after ten seconds', async () => {
  const state = await loadOptionsPage({ ok: false });
  const input = state.elements.get('#token');
  const button = state.elements.get('#toggle-token-visibility');
  assert.equal(input.value, 'a'.repeat(32));
  assert.equal(button.disabled, false);
  button.click();
  assert.equal(input.type, 'text');
  assert.equal(button['aria-pressed'], 'true');
  const timer = state.timers.find(item => item.delay === 10_000);
  assert.ok(timer, 'revealed token should have a ten-second timeout');
  timer.callback();
  assert.equal(input.type, 'password');
  assert.equal(button['aria-pressed'], 'false');
});

test('saved token reveal hides when the settings page becomes hidden', async () => {
  const state = await loadOptionsPage({ ok: false });
  const input = state.elements.get('#token');
  const button = state.elements.get('#toggle-token-visibility');
  button.click();
  state.document.visibilityState = 'hidden';
  state.documentListeners.get('visibilitychange')();
  assert.equal(input.type, 'password');
  assert.equal(button['aria-pressed'], 'false');
});

test('saved token reveal hides on Escape and browser window blur', async () => {
  const state = await loadOptionsPage({ ok: false });
  const input = state.elements.get('#token');
  const button = state.elements.get('#toggle-token-visibility');
  button.click();
  state.documentListeners.get('keydown')({ key: 'Escape' });
  assert.equal(input.type, 'password');
  button.click();
  state.windowListeners.get('blur')();
  assert.equal(input.type, 'password');
  assert.equal(button['aria-pressed'], 'false');
});

test('saved token reveal hides on page exit and stays disabled without a token', async () => {
  const state = await loadOptionsPage({ ok: false });
  const input = state.elements.get('#token');
  const button = state.elements.get('#toggle-token-visibility');
  button.click();
  state.documentListeners.get('pagehide')();
  assert.equal(input.type, 'password');

  const emptyState = await loadOptionsPage({ ok: false }, '');
  const emptyButton = emptyState.elements.get('#toggle-token-visibility');
  const emptyInput = emptyState.elements.get('#token');
  assert.equal(emptyButton.disabled, true);
  emptyButton.click();
  assert.equal(emptyInput.type, 'password');
});
