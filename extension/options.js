import { normalizeBridgeToken } from './token.mjs';

const input = document.querySelector('#token');
const status = document.querySelector('#status');
const tokenFile = document.querySelector('#token-file');
const saved = await chrome.storage.local.get('bridgeToken');
input.value = saved.bridgeToken || '';

async function refreshBridgeStatus() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'ui.status' });
    if (state?.authenticated) {
      status.textContent = 'Bridge authenticated and ready.';
    } else if (state?.bridgeError) {
      status.textContent = `Bridge disconnected: ${state.bridgeError}`;
    } else if (state?.bridgeConnected) {
      status.textContent = 'Bridge connected; waiting for authentication…';
    } else {
      status.textContent = 'Bridge disconnected; waiting for connection…';
    }
  } catch {
    status.textContent = 'Could not read bridge status.';
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ui.changed') void refreshBridgeStatus();
});

async function saveToken(value) {
  let token;
  try {
    token = normalizeBridgeToken(value);
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  try {
    await chrome.storage.local.set({ bridgeToken: token });
  } catch {
    status.textContent = 'Could not save token in extension storage.';
    return;
  }
  try {
    await chrome.runtime.sendMessage({ type: 'bridge.reconnect' });
    status.textContent = 'Token saved locally. Reconnecting to the bridge…';
    void refreshBridgeStatus();
  } catch {
    status.textContent = 'Token saved locally, but reconnect failed. Reload the extension and retry.';
  }
}

document.querySelector('#save').addEventListener('click', () => saveToken(input.value));

document.querySelector('#import').addEventListener('click', async () => {
  const file = tokenFile.files?.[0];
  if (!file) {
    status.textContent = 'Choose the bridge.token file first.';
    return;
  }
  if (file.size > 4096) {
    status.textContent = 'Token file exceeds the 4096-byte limit.';
    tokenFile.value = '';
    return;
  }
  let contents;
  try {
    contents = await file.text();
  } catch {
    status.textContent = 'Could not read token file.';
    tokenFile.value = '';
    return;
  } finally {
    tokenFile.value = '';
  }
  await saveToken(contents);
});

void refreshBridgeStatus();
