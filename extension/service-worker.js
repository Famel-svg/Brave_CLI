const WS_URL = 'ws://127.0.0.1:9229';
const HEARTBEAT_MS = 20_000;
const MAX_MESSAGE_CHARS = 4_000_000;
let socket = null;
let reconnectDelay = 500;
let attachedTabId = null;
let attachedTab = null;
let authenticated = false;
let bridgeError = '';
let authRejected = false;
let tokenMismatch = false;
let bridgeToken = '';
let tokenLoaded = false;
let storageRevision = 0;
const WORKER_BUILD = '0.1.2';

const notifyPopup = () => chrome.runtime.sendMessage({ type: 'ui.changed' }).catch(() => {});
const safeError = (e) => String(e?.message || e).slice(0, 500);
const redactText = (value) => String(value || '').replace(/\b(password|passwd|secret|token|cookie|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]').slice(0, 1200);

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Local bridge is disconnected');
  const frame = JSON.stringify(payload);
  if (frame.length > MAX_MESSAGE_CHARS) throw new Error('Bridge message exceeds size limit');
  socket.send(frame);
}

async function connectBridge() {
  if (!tokenLoaded) return;
  if (authRejected) return;
  if (tokenMismatch) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket(WS_URL);
  socket = ws;
  authenticated = false;
  bridgeError = '';
  ws.addEventListener('open', async () => {
    reconnectDelay = 500;
    try {
      if (socket !== ws) {
        ws.close(1000, 'superseded connection');
        return;
      }
      ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: bridgeToken }));
      notifyPopup();
    } catch (e) {
      bridgeError = safeError(e);
      ws.close();
    }
  });
  ws.addEventListener('message', (event) => {
    if (socket !== ws) return;
    if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_CHARS) {
      ws.close(4009, 'Message too large');
      return;
    }
    let message;
    try { message = JSON.parse(event.data); } catch { ws.close(4007, 'Invalid JSON'); return; }
    if (message?.type === 'hello' && message.ok === true) {
      authenticated = true;
      authRejected = false;
      tokenMismatch = false;
      bridgeError = '';
      notifyPopup();
      return;
    }
    if (message?.type === 'hello' && message.ok !== true) {
      authenticated = false;
      bridgeError = String(message.error || 'Authentication rejected').slice(0, 300);
      tokenMismatch = bridgeError === 'token mismatch';
      authRejected = !tokenMismatch;
      notifyPopup();
      // Browser WebSocket API reserves 1008; use an application-defined code.
      ws.close(4008, bridgeError);
      return;
    }
    if (message?.type === 'request' && typeof message.id === 'string') {
      handleRequest(message).then((result) => send({ type: 'response', id: message.id, ok: true, result }))
        .catch((e) => {
          try { send({ type: 'response', id: message.id, ok: false, error: safeError(e) }); } catch {}
        });
    }
  });
  ws.addEventListener('error', () => {
    if (socket !== ws) return;
    bridgeError = 'Cannot reach ws://127.0.0.1:9229';
    notifyPopup();
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = null;
    authenticated = false;
    notifyPopup();
    if (authRejected || tokenMismatch) return;
    const wait = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
    setTimeout(connectBridge, wait);
  });
}

function reconnectBridge() {
  authRejected = false;
  tokenMismatch = false;
  authenticated = false;
  bridgeError = '';
  const previous = socket;
  socket = null;
  if (previous && previous.readyState !== WebSocket.CLOSED) {
    try { previous.close(1000, 'reconnect requested'); } catch {}
  }
  connectBridge();
  notifyPopup();
}

setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) {
    try { send({ type: 'ping', at: Date.now() }); } catch {}
  } else if (!authRejected) connectBridge();
}, HEARTBEAT_MS);
connectBridge();

chrome.runtime.onInstalled.addListener(() => connectBridge());
chrome.runtime.onStartup.addListener(() => connectBridge());
const startupStorageRevision = storageRevision;
chrome.storage.local.get('bridgeToken').then(({ bridgeToken: savedToken = '' }) => {
  if (storageRevision === startupStorageRevision) bridgeToken = savedToken;
  tokenLoaded = true;
  connectBridge();
}).catch((error) => {
  if (storageRevision !== startupStorageRevision) return;
  bridgeError = safeError(error);
  notifyPopup();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.bridgeToken) {
    storageRevision += 1;
    bridgeToken = changes.bridgeToken.newValue || '';
    tokenLoaded = true;
    tokenMismatch = false;
    authRejected = false;
    reconnectBridge();
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === attachedTabId) {
    attachedTabId = null;
    attachedTab = null;
    bridgeError = reason === 'target_closed' ? 'Attached tab closed' : `Debugger detached: ${reason}`;
    notifyPopup();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== attachedTabId || (!changeInfo.url && changeInfo.status !== 'complete')) return;
  attachedTab = {
    tabId,
    title: (tab.title || attachedTab?.title || '').slice(0, 500),
    url: tab.url || attachedTab?.url || ''
  };
  notifyPopup();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === attachedTabId) {
    attachedTabId = null;
    attachedTab = null;
    notifyPopup();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'ui.status') {
    respond({ bridgeConnected: socket?.readyState === WebSocket.OPEN, authenticated, bridgeError, attached: attachedTab, workerBuild: WORKER_BUILD });
    return;
  }
  if (message.type === 'ui.attachActive') {
    attachActiveTab().then(() => respond({ ok: true })).catch((e) => respond({ error: safeError(e) }));
    return true;
  }
  if (message.type === 'ui.detach') {
    detachTab().then(() => respond({ ok: true })).catch((e) => respond({ error: safeError(e) }));
    return true;
  }
  if (message.type === 'bridge.reconnect') {
    reconnectBridge();
    respond({ ok: true });
    return;
  }
});

function parseHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('URL must be a string under 8192 characters');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are allowed');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are rejected');
  return url.href;
}

function requireAuth() {
  if (!authenticated) throw new Error('Bridge is not authenticated');
}

function requireTab() {
  if (!Number.isInteger(attachedTabId)) throw new Error('No tab attached; attach explicitly from extension popup');
  return { tabId: attachedTabId };
}

async function handleRequest(request) {
  requireAuth();
  if (typeof request.id !== 'string' || request.id.length > 128) throw new Error('Invalid request id');
  if (!request.command || typeof request.command !== 'string') throw new Error('Missing command');
  const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params : {};
  switch (request.command) {
    case 'status':
      return { attached: attachedTab !== null, tab: attachedTab, bridgeConnected: socket?.readyState === WebSocket.OPEN };
    case 'inspect':
      return inspectAttachedTab();
    case 'navigate': {
      const url = parseHttpUrl(params.url);
      await chrome.tabs.update(requireTab().tabId, { url });
      return { navigated: true, url };
    }
    case 'openTab': {
      const url = parseHttpUrl(params.url);
      const tab = await chrome.tabs.create({ url, active: true });
      return { opened: true, tabId: tab.id, url: tab.url || url };
    }
    default: throw new Error(`Unsupported command: ${request.command.slice(0, 80)}`);
  }
}

async function attachActiveTab() {
  if (attachedTabId !== null) throw new Error('Detach current tab before attaching another');
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !Number.isInteger(tab.id)) throw new Error('No active tab found');
  parseHttpUrl(tab.url || '');
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  attachedTabId = tab.id;
  attachedTab = { tabId: tab.id, title: (tab.title || '').slice(0, 500), url: tab.url || '' };
  bridgeError = '';
  notifyPopup();
}

async function detachTab() {
  if (attachedTabId === null) return;
  const tabId = attachedTabId;
  await chrome.debugger.detach({ tabId });
  attachedTabId = null;
  attachedTab = null;
  notifyPopup();
}

async function inspectAttachedTab() {
  const target = requireTab();
  const expression = `(() => {
    const visible = e => { const r=e.getBoundingClientRect(),s=getComputedStyle(e); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0; };
    const sensitive = e => { const words=[e.type,e.name,e.id,e.getAttribute('autocomplete'),e.getAttribute('aria-label'),e.getAttribute('placeholder'),e.labels?[...e.labels].map(x=>x.innerText).join(' '):''].join(' '); return /password|passwd|secret|token|cookie|authorization|api[_-]?key|credential|private|cvv|card/i.test(words); };
    const clean = s => (s||'').replace(/\\b(password|passwd|secret|token|cookie|authorization|api[_-]?key)\\s*[:=]\\s*[^\\s,;]+/ig,'$1=[REDACTED]').slice(0,1200);
    let text=clean(document.body?.innerText||'');
    for(const e of document.querySelectorAll('input,textarea,[contenteditable=true]')) if(sensitive(e)&&e.value) text=text.split(e.value).join('[REDACTED]');
    const elements=[...document.querySelectorAll('a,button,input,textarea,select,[role],img,video,canvas,iframe,summary')].filter(visible).slice(0,1200).map(e=>{
      const r=e.getBoundingClientRect(), secret=(e.matches('input,textarea,[contenteditable=true]')&&sensitive(e));
      const name=secret?'[REDACTED FIELD]':clean(e.getAttribute('aria-label')||e.getAttribute('alt')||e.getAttribute('title')||e.innerText||e.textContent||'');
      return {tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||'',name,text:secret?'[REDACTED]':clean(e.innerText||e.textContent||''),href:e instanceof HTMLAnchorElement?e.href:null,rect:{x:r.x,y:r.y,width:r.width,height:r.height},disabled:!!e.disabled};
    });
    const u=new URL(location.href); return {url:u.href,title:document.title.slice(0,500),viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},scroll:{x:scrollX,y:scrollY,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight},text,visibleElements:elements};
  })()`;
  const [{ result }, ax] = await Promise.all([
    chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    chrome.debugger.sendCommand(target, 'Accessibility.enable', {}).then(() => chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree', {}))
  ]);
  if (result?.exceptionDetails) throw new Error('Page inspection failed');
  const snapshot = result?.result?.value;
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Page inspection returned no snapshot');
snapshot.accessibilityTree = (ax?.nodes || []).slice(0, 5000).map((node) => ({
    role: node.role?.value || '',
    name: ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(node.role?.value)
      ? '[REDACTED FIELD]'
      : redactText(node.name?.value || ''),
    description: ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(node.role?.value)
      ? ''
      : redactText(node.description?.value || '')
  }));
  return snapshot;
}
