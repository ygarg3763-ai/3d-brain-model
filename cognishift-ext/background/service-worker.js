// CogniAdapt Service Worker v2.0

const DEFAULTS = {
  enabled: true, adaptUI: true, showFloatingHUD: true,
  notifyOnLevelChange: true, breakReminders: true,
  breakIntervalMin: 25, sensitivity: 0.7, trackingEnabled: true,
  dataRetentionDays: 7,
  adhdReadingGuide: true, adhdFocusRing: true,
  adhdReduceMotion: true, adhdHighContrast: false,
};

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULTS });
  const { sessions } = await chrome.storage.local.get('sessions');
  if (!sessions) await chrome.storage.local.set({ sessions: [] });
  chrome.alarms.create('dataPrune', { periodInMinutes: 60 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'dataPrune') {
    const { settings, sessions } = await chrome.storage.local.get(['settings', 'sessions']);
    if (!sessions) return;
    const cutoff = Date.now() - (settings?.dataRetentionDays || 7) * 86400000;
    await chrome.storage.local.set({ sessions: sessions.filter(s => s.timestamp > cutoff) });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SAVE_SESSION_DATA') {
    chrome.storage.local.get('sessions').then(({ sessions }) => {
      const list = sessions || [];
      list.push({ ...msg.data, timestamp: Date.now() });
      if (list.length > 500) list.splice(0, list.length - 500);
      chrome.storage.local.set({ sessions: list }).then(() => sendResponse({ ok: true }));
    });
    return true;
  }
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get('settings').then(({ settings }) => sendResponse(settings || DEFAULTS));
    return true;
  }
  if (msg.type === 'GET_HISTORY') {
    chrome.storage.local.get('sessions').then(({ sessions }) => sendResponse(sessions || []));
    return true;
  }
  if (msg.type === 'UPDATE_SETTINGS') {
    chrome.storage.local.get('settings').then(({ settings }) => {
      const updated = { ...DEFAULTS, ...settings, ...msg.data };
      chrome.storage.local.set({ settings: updated }).then(() => {
        sendResponse({ ok: true });
        chrome.tabs.query({}).then(tabs => {
          tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: updated }).catch(() => {}));
        });
      });
    });
    return true;
  }
  if (msg.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'CLEAR_DATA') {
    chrome.storage.local.set({ sessions: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
});
