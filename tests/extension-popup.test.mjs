import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class ElementMock {
  listeners = new Map();
  textContent = '';
  disabled = false;

  addEventListener(type, listener) { this.listeners.set(type, listener); }
  click() { return this.listeners.get('click')?.(); }
}

test('popup exposes reconnect and keeps tab attachment gated by bridge auth', async () => {
  const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  assert.match(html, /id="reconnect"/);

  const elements = new Map(['connection', 'tab', 'error', 'reconnect', 'attach', 'detach']
    .map(id => [id, new ElementMock()]));
  const runtimeCalls = [];
  const runtime = {
    onMessage: { addListener() {} },
    sendMessage: async message => {
      runtimeCalls.push(message);
      if (message.type === 'ui.status') {
        return { bridgeConnected: false, authenticated: false, attached: null, bridgeError: 'token mismatch' };
      }
      return { ok: true };
    },
  };

  vm.runInNewContext(await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8'), {
    chrome: { runtime },
    document: { querySelector: selector => elements.get(selector.slice(1)) },
  }, { filename: 'popup.js' });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('attach').disabled, true);
  assert.match(elements.get('connection').textContent, /token mismatch/);

  await elements.get('reconnect').click();
  assert.ok(runtimeCalls.some(message => message.type === 'bridge.reconnect'));
  assert.equal(elements.get('reconnect').disabled, false);
  assert.equal(elements.get('attach').disabled, true);
});
