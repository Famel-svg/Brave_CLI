const input = document.querySelector('#token');
const status = document.querySelector('#status');
const saved = await chrome.storage.local.get('bridgeToken');
input.value = saved.bridgeToken || '';

document.querySelector('#save').addEventListener('click', async () => {
  if (input.value.length > 4096) {
    status.textContent = 'Token must be 4096 characters or fewer.';
    return;
  }
  await chrome.storage.local.set({ bridgeToken: input.value });
  await chrome.runtime.sendMessage({ type: 'bridge.reconnect' });
  status.textContent = 'Saved locally. The service worker will authenticate with the new token.';
});
