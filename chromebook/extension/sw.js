// Opens (or focuses) the Windowcast host window. The host page does all the work; this worker only
// reacts to the toolbar icon, to Chrome starting, and to the host window closing.

const HOST_PAGE = chrome.runtime.getURL('host.html');

async function findHostTab() {
  const tabs = await chrome.tabs.query({ url: `${HOST_PAGE}*` });
  return tabs[0] || null;
}

async function openHost({ nominate = null, auto = false } = {}) {
  const existing = await findHostTab();
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true, state: 'normal' });
    if (nominate !== null) {
      await chrome.runtime.sendMessage({ type: 'pick', nominate }).catch(() => {});
    }
    return;
  }
  const query = new URLSearchParams();
  if (nominate !== null) query.set('nominate', String(nominate));
  if (auto) query.set('auto', '1');
  await chrome.windows.create({ url: `host.html?${query}`, type: 'popup', width: 440, height: 760, focused: true });
}

// Clicking the icon in a window nominates that window for sharing and opens the picker.
chrome.action.onClicked.addListener((tab) => {
  openHost({ nominate: tab.windowId });
});

// After a restart, reopen the host and ask for the window again if it was shared before.
chrome.runtime.onStartup.addListener(async () => {
  const { settings = {}, wasSharing = false } = await chrome.storage.local.get(['settings', 'wasSharing']);
  if (settings.autoStart !== false && wasSharing) openHost({ auto: true });
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') openHost();
});

// Nothing is shared once the host window is gone: let the Chromebook sleep again, and end remote control
// so Chrome's "started debugging" bar goes away (the sessions belong to the extension, not the window).
chrome.windows.onRemoved.addListener(async () => {
  if (await findHostTab()) return;
  chrome.power.releaseKeepAwake();
  const targets = await chrome.debugger.getTargets();
  await Promise.all(targets
    .filter((t) => t.attached && t.tabId !== undefined)
    .map((t) => chrome.debugger.detach({ tabId: t.tabId }).catch(() => {})));
});
