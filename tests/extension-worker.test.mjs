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

async function createWorker(initialToken, { deferStorage = false, nativeToken = null, deferNativeStartup = false } = {}) {
  FakeWebSocket.instances = [];
  let savedToken = initialToken;
  let resolveInitialStorage;
  let deferFirstRead = deferStorage;
  let nativeMessagingCalls = 0;
  let deferNextNativeResponse = false;
  let resolveDeferredNativeResponse;
  let resolveInitialNativeResponse;
  const pendingTimers = [];
  let heartbeat;
  const runtimeMessages = new EventHook();
  const storageChanges = new EventHook();
  const chrome = {
    runtime: {
      onMessage: runtimeMessages,
      onInstalled: new EventHook(),
      onStartup: new EventHook(),
      sendMessage: async () => undefined,
      sendNativeMessage: async (host, message) => {
        nativeMessagingCalls += 1;
        assert.equal(host, 'com.famel.brave_cli');
        assert.equal(message.type, 'get_bridge_token');
        if (!nativeToken) throw new Error('native host unavailable');
        if (deferNativeStartup && nativeMessagingCalls === 1) {
          return await new Promise(resolve => {
            resolveInitialNativeResponse = () => resolve({ ok: true, token: nativeToken });
          });
        }
        if (deferNextNativeResponse) {
          deferNextNativeResponse = false;
          return await new Promise(resolve => { resolveDeferredNativeResponse = () => resolve({ ok: true, token: nativeToken }); });
        }
        return { ok: true, token: nativeToken };
      },
    },
    storage: {
      local: {
        setAccessLevel: async () => undefined,
        set: async () => undefined,
        get: key => {
          if (key === 'bridgeDiagnostics') return Promise.resolve({ bridgeDiagnostics: [] });
          if (key === 'bridgeToken' && deferFirstRead) {
            deferFirstRead = false;
            return new Promise(resolve => {
              const observedToken = savedToken;
              resolveInitialStorage = () => resolve({ bridgeToken: observedToken });
            });
          }
          return Promise.resolve({ bridgeToken: savedToken });
        },
      },
      onChanged: storageChanges,
    },
    debugger: { onDetach: new EventHook() },
    tabs: { onUpdated: new EventHook(), onRemoved: new EventHook() },
  };

  const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    chrome,
    WebSocket: FakeWebSocket,
    setInterval: callback => { heartbeat = callback; return 1; },
    setTimeout: (callback, delay) => { pendingTimers.push({ callback, delay }); return pendingTimers.length; },
  }, { filename: 'service-worker.js' });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (FakeWebSocket.instances.length > 0 || (deferStorage && resolveInitialStorage) || (deferNativeStartup && resolveInitialNativeResponse)) break;
    await new Promise(resolve => setImmediate(resolve));
  }

  return {
    get sockets() { return FakeWebSocket.instances; },
    loadInitialStorage() {
      assert.ok(resolveInitialStorage, 'expected storage read to be pending');
      resolveInitialStorage({ bridgeToken: savedToken });
    },
    releaseNativeStartup() {
      assert.ok(resolveInitialNativeResponse, 'expected startup Native Messaging response to be pending');
      resolveInitialNativeResponse();
      resolveInitialNativeResponse = null;
    },
    setSavedToken(value) { savedToken = value; },
    setNativeToken(value) { nativeToken = value; },
    deferNextNativeResponse() { deferNextNativeResponse = true; },
    releaseNativeResponse() {
      assert.ok(resolveDeferredNativeResponse, 'expected a deferred Native Messaging response');
      resolveDeferredNativeResponse();
      resolveDeferredNativeResponse = null;
    },
    get nativeMessagingCalls() { return nativeMessagingCalls; },
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
    heartbeat() { heartbeat(); },
  };
}

async function authenticate(socket, ok, error = 'authentication failed', code = undefined) {
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit('open');
  await new Promise(resolve => setImmediate(resolve));
  socket.emit('message', { data: JSON.stringify({ type: 'hello', ok, error: ok ? undefined : error, code }) });
}

test('retries after rejected handshake when reconnect is requested', async () => {
  const dummyToken = 'a'.repeat(32);
  const worker = await createWorker(dummyToken);
  const first = worker.sockets[0];
  await authenticate(first, false);

  assert.equal(first.sent[0].token, dummyToken);
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).bridgeError, 'authentication failed');
  worker.heartbeat();
  assert.equal(worker.sockets.length, 1, 'heartbeat must not retry rejected credentials');
  assert.equal(worker.sendRuntimeMessage({ type: 'bridge.reconnect' }).ok, true);
  await new Promise(resolve => setImmediate(resolve));
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

test('waits for extension storage before opening bridge socket', async () => {
  const token = 'd'.repeat(32);
  const worker = await createWorker(token, { deferStorage: true });
  assert.equal(worker.sockets.length, 0);

  worker.loadInitialStorage();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.sockets.length, 1);

  const socket = worker.sockets[0];
  await authenticate(socket, true);
  assert.equal(socket.sent[0].token, token);
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).authenticated, true);
});

test('uses native host token instead of stale extension storage', async () => {
  const staleToken = 'a'.repeat(32);
  const bridgeToken = 'b'.repeat(32);
  const worker = await createWorker(staleToken, { nativeToken: bridgeToken });
  assert.equal(worker.sockets.length, 1);

  const socket = worker.sockets[0];
  await authenticate(socket, true);
  assert.equal(socket.sent[0].token, bridgeToken);
  assert.notEqual(socket.sent[0].token, staleToken);
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).authenticated, true);
});

test('native startup token overrides storage change made while host response is pending', async () => {
  const staleToken = 'a'.repeat(32);
  const bridgeToken = 'b'.repeat(32);
  const interveningToken = 'c'.repeat(32);
  const worker = await createWorker(staleToken, {
    nativeToken: bridgeToken,
    deferNativeStartup: true,
  });
  assert.equal(worker.sockets.length, 0);

  worker.setSavedToken(interveningToken);
  worker.emitStorageChange({ bridgeToken: { newValue: interveningToken } });
  assert.equal(worker.sockets.length, 1, 'storage event may start a provisional connection');

  worker.releaseNativeStartup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.sockets.length, 2, 'native token arrival must replace provisional connection');
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).tokenSource, 'native_messaging');

  const socket = worker.sockets[1];
  await authenticate(socket, true);
  assert.equal(socket.sent[0].token, bridgeToken);
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).authenticated, true);
});

test('automatically replaces mismatched storage token from native host and reconnects', async () => {
  const staleToken = 'a'.repeat(32);
  const bridgeToken = 'b'.repeat(32);
  const worker = await createWorker(staleToken);
  const first = worker.sockets[0];
  worker.setNativeToken(bridgeToken);

  await authenticate(first, false, 'token mismatch');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.sockets.length, 2);
  assert.equal(worker.nativeMessagingCalls, 2, 'startup and mismatch recovery should each call host once');

  const second = worker.sockets[1];
  await authenticate(second, true);
  assert.equal(second.sent[0].token, bridgeToken);
  assert.notEqual(second.sent[0].token, staleToken);
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).tokenSource, 'native_messaging');
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).authenticated, true);
});

test('does not loop when native host cannot repair a token mismatch', async () => {
  const worker = await createWorker('a'.repeat(32));
  await authenticate(worker.sockets[0], false, 'token mismatch');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(worker.sockets.length, 1);
  assert.equal(worker.nativeMessagingCalls, 2, 'one startup call plus one bounded recovery call');
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).tokenMismatch, true);
  assert.match(worker.sendRuntimeMessage({ type: 'ui.status' }).bridgeError, /Native Messaging recovery failed/);
  worker.heartbeat();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.sockets.length, 1, 'bad token remains blocked instead of reconnecting forever');
  assert.equal(worker.nativeMessagingCalls, 2);
});

test('recognizes stable mismatch code even when display error wording changes', async () => {
  const worker = await createWorker('a'.repeat(32));
  worker.setNativeToken('b'.repeat(32));
  await authenticate(worker.sockets[0], false, 'Authentication rejected', 'TOKEN_MISMATCH');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.sockets.length, 2);
  assert.equal(worker.sockets[1].sent.length, 0);
  await authenticate(worker.sockets[1], true);
  assert.equal(worker.sockets[1].sent[0].token, 'b'.repeat(32));
});

test('storage change during native recovery remains authoritative', async () => {
  const worker = await createWorker('a'.repeat(32));
  const socket = worker.sockets[0];
  worker.setNativeToken('b'.repeat(32));
  worker.deferNextNativeResponse();
  await authenticate(socket, false, 'token mismatch');
  await new Promise(resolve => setImmediate(resolve));

  const userToken = 'c'.repeat(32);
  worker.setSavedToken(userToken);
  worker.emitStorageChange({ bridgeToken: { newValue: userToken } });
  assert.equal(worker.sockets.length, 2);
  await authenticate(worker.sockets[1], true);
  worker.releaseNativeResponse();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).authenticated, true);
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).tokenSource, 'extension_storage');
  assert.equal(worker.sockets.length, 2);
});

test('does not overwrite token change with a stale startup storage read', async () => {
  const oldToken = 'e'.repeat(32);
  const newToken = 'f'.repeat(32);
  const worker = await createWorker(oldToken, { deferStorage: true });
  worker.setSavedToken(newToken);
  worker.emitStorageChange({ bridgeToken: { newValue: newToken } });
  assert.equal(worker.sockets.length, 1);

  worker.loadInitialStorage();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.sockets.length, 1);

  const socket = worker.sockets[0];
  await authenticate(socket, true);
  assert.equal(socket.sent[0].token, newToken);
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).authenticated, true);
});

test('manual reconnect reloads storage even when token was already saved', async () => {
  const oldToken = '1'.repeat(32);
  const currentToken = '2'.repeat(32);
  const worker = await createWorker(oldToken);
  const first = worker.sockets[0];
  await authenticate(first, true);

  // Simulate a token already saved in storage with no onChanged event.
  worker.setSavedToken(currentToken);
  assert.equal(worker.sendRuntimeMessage({ type: 'bridge.reconnect' }).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  const second = worker.sockets[1];
  await authenticate(second, true);

  assert.equal(second.sent[0].token, currentToken);
  assert.equal(worker.sendRuntimeMessage({ type: 'ui.status' }).authenticated, true);
});
