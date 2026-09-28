import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class EventHook {
  listeners = [];
  addListener(listener) { this.listeners.push(listener); }
  emit(...args) { for (const listener of this.listeners) listener(...args); }
}

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  send(frame) { this.sent.push(JSON.parse(frame)); }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {});
  }
}

async function createWorker(initialToken) {
  FakeWebSocket.instances = [];
  let savedToken = initialToken;
  const pendingTimers = [];
  const runtimeMessages = new EventHook();
  const storageChanges = new EventHook();
  const chrome = {
    runtime: {
      onMessage: runtimeMessages,
      onInstalled: new EventHook(),
      onStartup: new EventHook(),
      sendMessage: async () => undefined,
    },
    storage: {
      local: { get: async () => ({ bridgeToken: savedToken }) },
      onChanged: storageChanges,
    },
    debugger: { onDetach: new EventHook() },
    tabs: { onUpdated: new EventHook(), onRemoved: new EventHook() },
  };

  const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    chrome,
    WebSocket: FakeWebSocket,
    setInterval: () => 1,
    setTimeout: (callback, delay) => { pendingTimers.push({ callback, delay }); return pendingTimers.length; },
  }, { filename: 'service-worker.js' });

  return {
    get sockets() { return FakeWebSocket.instances; },
    setSavedToken(value) { savedToken = value; },
    emitStorageChange(changes) { storageChanges.emit(changes, 'local'); },
    sendRuntimeMessage(message) {
      let response;
      runtimeMessages.listeners[0](message, {}, value => { response = value; });
      return response;
    },
    runNextTimer() {
      const timer = pendingTimers.shift();
      assert.ok(timer, 'expected a scheduled bridge reconnect');
      timer.callback();
      return timer.delay;
    },
  };
}

async function authenticate(socket, ok) {
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit('open');
  await new Promise(resolve => setImmediate(resolve));
  socket.emit('message', { data: JSON.stringify({ type: 'hello', ok, error: ok ? undefined : 'authentication failed' }) });
}

test('retries after rejected handshake when reconnect is requested', async () => {
  const dummyToken = 'a'.repeat(32);
  const worker = await createWorker(dummyToken);
  const first = worker.sockets[0];
  await authenticate(first, false);

  assert.equal(first.sent[0].token, dummyToken);
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).bridgeError, 'authentication failed');
  assert.equal(worker.sendRuntimeMessage({ type: 'bridge.reconnect' }).ok, true);
  assert.equal(worker.sockets.length, 2);

  const second = worker.sockets[1];
  await authenticate(second, true);
  assert.equal(second.sent[0].token, dummyToken);
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).authenticated, true);

  first.emit('message', { data: JSON.stringify({ type: 'hello', ok: false, error: 'stale rejection' }) });
  first.emit('close');
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).authenticated, true);
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).bridgeError, '');
});

test('reconnects with newly stored token after storage change', async () => {
  const oldToken = 'b'.repeat(32);
  const newToken = 'c'.repeat(32);
  const worker = await createWorker(oldToken);
  const first = worker.sockets[0];
  await authenticate(first, true);

  worker.setSavedToken(newToken);
  worker.emitStorageChange({ bridgeToken: { newValue: newToken } });
  assert.equal(worker.sockets.length, 2);
  assert.equal(first.readyState, FakeWebSocket.CLOSED);

  const second = worker.sockets[1];
  await authenticate(second, true);
  assert.equal(second.sent[0].token, newToken);
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).authenticated, true);
});
