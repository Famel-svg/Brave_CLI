import { normalizeBridgeToken, tokensMatchByFingerprint } from './token.mjs';

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
      status.textContent = `Bridge disconnected: ${state.bridgeError} (worker ${state?.workerBuild || 'unknown'})`;
    } else if (state?.bridgeConnected) {
      status.textContent = 'Bridge connected; waiting for authentication…';
    } else {
      status.textContent = `Bridge disconnected; waiting for connection… (worker ${state?.workerBuild || 'unknown'})`;
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
  let tokenUnchanged = false;
  try {
    const saved = await chrome.storage.local.get('bridgeToken');
    tokenUnchanged = saved.bridgeToken === token;
    await chrome.storage.local.set({ bridgeToken: token });
  } catch {
    status.textContent = 'Could not save token in extension storage.';
    return;
  }
  try {
    if (tokenUnchanged) await chrome.runtime.sendMessage({ type: 'bridge.reconnect' });
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
  if (file.size > 8192) {
    status.textContent = 'Token file exceeds the 8192-byte limit.';
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

document.querySelector('#compare').addEventListener('click', async () => {
  const file = tokenFile.files?.[0];
  if (!file) {
    status.textContent = 'Choose the local bridge.token file to compare.';
    return;
  }
  if (file.size > 8192) {
    status.textContent = 'Token file exceeds the 8192-byte limit.';
    tokenFile.value = '';
    return;
  }

  let fileToken;
  try {
    fileToken = normalizeBridgeToken(await file.text());
  } catch {
    status.textContent = 'Token file is invalid or could not be read.';
    tokenFile.value = '';
    return;
  }
  tokenFile.value = '';

  try {
    const { bridgeToken = '' } = await chrome.storage.local.get('bridgeToken');
    if (!bridgeToken) {
      status.textContent = 'No token is saved in this extension.';
      return;
    }
    const matches = await tokensMatchByFingerprint(fileToken, bridgeToken);
    status.textContent = matches
      ? 'MATCH: saved extension token matches local bridge.token.'
      : 'MISMATCH: saved extension token differs from local bridge.token.';
  } catch {
    status.textContent = 'Could not compare tokens locally.';
  }
});

void refreshBridgeStatus();
