// Service worker: AI API proxy, NetAcad hotkey relay and script injection into already-open Coursera / NetAcad tabs. NSolver, made by Naki — https://github.com/Naki-404/NSolver
importScripts('shared.js');

const API_TIMEOUT_MS = 120000;
// Same list as the netacad.js content script in manifest.json (netacad.net: legacy exams, skillsforall.com: merged into NetAcad).
const NETACAD_MATCHES = chrome.runtime.getManifest().content_scripts.find(entry => entry.js.includes('netacad.js')).matches;
const ALLOWED_API_PREFIXES = [
    'https://octavapi.shop/v1/',
    'https://api.anthropic.com/v1/',
    'https://api.openai.com/v1/',
    'https://generativelanguage.googleapis.com/v1beta/'
];

// ---- Install / update: undo the pin mode of v2.0–2.1 and attach to open Coursera and NetAcad tabs right away,
// so hotkeys work without reloading the page.
async function injectIntoOpenTabs() {
    const tabs = await chrome.tabs.query({ url: 'https://www.coursera.org/learn/*' });
    for (const tab of tabs) {
        try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['interceptor.js'], world: 'MAIN' });
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared.js', 'model-provider.js', 'content.js'] });
        } catch (error) {
            console.warn('[Naki] Could not attach to tab', tab.id, error.message);
        }
    }
    const netacadTabs = await chrome.tabs.query({ url: NETACAD_MATCHES });
    for (const tab of netacadTabs) {
        try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['shared.js', 'model-provider.js', 'netacad.js'] });
        } catch (error) {
            console.warn('[Naki] Could not attach to tab', tab.id, error.message);
        }
    }
}

chrome.runtime.onInstalled.addListener(async () => {
    await chrome.action.setPopup({ popup: 'popup.html' }).catch(() => { });
    await chrome.storage.local.remove(['pinned']);
    await injectIntoOpenTabs();
});

// ---- AI API proxy (content scripts on coursera.org and netacad.com are subject to CORS).
async function apiRequest(message) {
    if (typeof message.url !== 'string' || !ALLOWED_API_PREFIXES.some(prefix => message.url.startsWith(prefix))) {
        return { networkError: 'Blocked request to unexpected URL' };
    }
    const method = message.method === 'GET' ? 'GET' : 'POST';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
        const headers = { ...(message.headers || {}) };
        if (method === 'POST') headers['Content-Type'] = 'application/json';
        if (message.body && message.body.stream) headers.Accept = 'text/event-stream';
        const response = await fetch(message.url, {
            method,
            signal: controller.signal,
            headers,
            body: method === 'POST' ? JSON.stringify(message.body || {}) : undefined
        });
        return {
            status: response.status,
            contentType: response.headers.get('content-type') || '',
            text: await response.text()
        };
    } catch (error) {
        const reason = error.name === 'AbortError' ? `timeout after ${API_TIMEOUT_MS / 1000}s` : (error.message || String(error));
        return { networkError: reason };
    } finally {
        clearTimeout(timer);
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === Naki.MSG.API_REQUEST) {
        apiRequest(message).then(sendResponse);
        return true;
    }
    // A hotkey pressed inside a NetAcad course frame: the top frame owns the UI and does the work.
    const relayed = [Naki.MSG.SOLVE, Naki.MSG.SKIP];
    if (message?.type === Naki.MSG.RELAY && sender.tab && relayed.includes(message.action)) {
        chrome.tabs.sendMessage(sender.tab.id, { type: message.action }, { frameId: 0 }).catch(() => { });
    }
});
