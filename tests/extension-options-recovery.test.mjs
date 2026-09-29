import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadOptionsPage(nativeMessagingResult) {
  const elements = new Map();
  const timers = [];
  const statusState = {
    nativeHostState: 'unavailable',
    tokenMismatch: true,
    authenticated: false,
    bridgeConnected: false,
    workerBuild: '0.1.6',
  };
  let reloadCount = 0;
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
    storage: { local: { get: async () => ({ bridgeToken: '' }), set: async () => undefined } },
  };
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, { addEventListener() {}, textContent: '', value: '', files: [] });
      }
      return elements.get(selector);
    },
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
  return { elements, timers, get reloadCount() { return reloadCount; } };
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
