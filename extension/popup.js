const connection = document.querySelector('#connection');
const tabLabel = document.querySelector('#tab');
const error = document.querySelector('#error');
const attachButton = document.querySelector('#attach');
const detachButton = document.querySelector('#detach');

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'ui.status' });
  connection.textContent = state.bridgeConnected
    ? (state.authenticated ? 'Bridge connected and authenticated' : 'Bridge connected; token required')
    : `Bridge disconnected${state.bridgeError ? `: ${state.bridgeError}` : ''}`;
  tabLabel.textContent = state.attached
    ? `Attached: ${state.attached.url || '(URL unavailable)'}`
    : 'No tab attached';
  attachButton.disabled = !state.bridgeConnected || state.attached !== null;
  detachButton.disabled = state.attached === null;
}

attachButton.addEventListener('click', async () => {
  error.textContent = '';
  attachButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ui.attachActive' });
    if (result?.error) throw new Error(result.error);
    await refresh();
  } catch (e) {
    error.textContent = e.message;
    await refresh();
  }
});

detachButton.addEventListener('click', async () => {
  error.textContent = '';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ui.detach' });
    if (result?.error) throw new Error(result.error);
    await refresh();
  } catch (e) {
    error.textContent = e.message;
    await refresh();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ui.changed') refresh().catch(() => {});
});
refresh().catch((e) => { connection.textContent = `Extension error: ${e.message}`; });
