import { normalizeBridgeToken, tokensMatchByFingerprint } from './token.mjs';

const input = document.querySelector('#token');
const tokenVisibilityButton = document.querySelector('#toggle-token-visibility');
const status = document.querySelector('#status');
const tokenFile = document.querySelector('#token-file');
const diagnosticSummary = document.querySelector('#diagnostic-summary');
const diagnosticsOutput = document.querySelector('#diagnostics');
const saved = await chrome.storage.local.get('bridgeToken');
input.value = saved.bridgeToken || '';
tokenVisibilityButton.disabled = !input.value;

let tokenVisibilityTimer = null;
function hideToken() {
  input.type = 'password';
  tokenVisibilityButton.textContent = 'Show token';
  tokenVisibilityButton.setAttribute('aria-pressed', 'false');
  if (tokenVisibilityTimer !== null) clearTimeout(tokenVisibilityTimer);
  tokenVisibilityTimer = null;
}

tokenVisibilityButton.addEventListener('click', () => {
  if (input.type === 'text') {
    hideToken();
    return;
  }
  if (!input.value) return;
  input.type = 'text';
  tokenVisibilityButton.textContent = 'Hide token';
  tokenVisibilityButton.setAttribute('aria-pressed', 'true');
  tokenVisibilityTimer = setTimeout(hideToken, 10_000);
});

input.addEventListener('input', () => {
  tokenVisibilityButton.disabled = !input.value;
  if (!input.value) hideToken();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hideToken();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') hideToken();
});
document.addEventListener('pagehide', hideToken);
window.addEventListener('blur', hideToken);

async function nativeTokenIsAuthoritative() {
  const state = await chrome.runtime.sendMessage({ type: 'ui.status' }).catch(() => null);
  return state?.nativeHostState === 'connected';
}

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

async function refreshDiagnostics() {
  try {
    const [state, log] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'ui.status' }),
      chrome.runtime.sendMessage({ type: 'ui.diagnostics' })
    ]);
    const entries = Array.isArray(log?.entries) ? log.entries : [];
    diagnosticSummary.textContent = `Worker ${state?.workerBuild || 'unknown'} | native host: ${state?.nativeHostState || 'unknown'} | token source: ${state?.tokenSource || 'unknown'} | token loaded: ${Boolean(state?.tokenLoaded)} | storage revision: ${state?.storageRevision ?? 'unknown'} | mismatch: ${Boolean(state?.tokenMismatch)} | auth rejected: ${Boolean(state?.authRejected)} | events: ${entries.length}`;
    diagnosticsOutput.textContent = JSON.stringify(entries, null, 2);
  } catch (error) {
    diagnosticSummary.textContent = `Could not read local diagnostics: ${String(error?.message || error)}`;
    diagnosticsOutput.textContent = '';
  }
}

async function recoverNativeMessaging() {
  let state = await chrome.runtime.sendMessage({ type: 'ui.status' }).catch(() => null);
  for (let attempt = 0; attempt < 10 && state?.nativeHostState === 'starting'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    state = await chrome.runtime.sendMessage({ type: 'ui.status' }).catch(() => null);
  }
  if (state?.authenticated || state?.tokenSource === 'native_messaging') return;
  if (state?.tokenMismatch !== true && state?.nativeHostState !== 'unavailable') return;

  status.textContent = 'Retrying the local Native Messaging host…';
  try {
    const response = await chrome.runtime.sendNativeMessage('com.famel.brave_cli', {
      type: 'get_bridge_token'
    });
    if (!response?.ok || typeof response.token !== 'string' || !/^[0-9a-f]{32,4096}$/i.test(response.token)) {
      throw new Error(response?.error || 'Native host returned invalid token metadata');
    }
    status.textContent = 'Native host responded. Restarting extension worker with shared token…';
    setTimeout(() => chrome.runtime.reload(), 250);
  } catch (error) {
    status.textContent = `Native host unavailable: ${String(error?.message || error).slice(0, 300)}`;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ui.changed') {
    void refreshBridgeStatus();
    void refreshDiagnostics();
  }
});

async function saveToken(value) {
  if (await nativeTokenIsAuthoritative()) {
    status.textContent = 'Native host supplies the bridge token. Manual token changes are disabled.';
    return;
  }
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
    input.value = token;
    tokenVisibilityButton.disabled = false;
    hideToken();
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
void refreshDiagnostics();
void recoverNativeMessaging();
document.querySelector('#refresh-diagnostics').addEventListener('click', () => void refreshDiagnostics());
document.querySelector('#export-diagnostics').addEventListener('click', async () => {
  await refreshDiagnostics();
  const blob = new Blob([diagnosticsOutput.textContent || '[]'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `brave-bridge-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});
document.querySelector('#clear-diagnostics').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'ui.clearDiagnostics' });
  await refreshDiagnostics();
});
