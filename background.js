// Service worker: AI API proxy, NetAcad screenshots and script injection into already-open Coursera / NetAcad tabs. NSolver, made by Naki — https://github.com/Naki-404/NSolver
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

// ---- Cisco NetAcad: screenshot of the visible tab for the vision prompt.
// Chrome allows it with activeTab (granted when the NSolver panel is opened) or the optional <all_urls> permission.
const CAPTURE_MAX_EDGE = 1920; // HiDPI screens give 3–4K screenshots; larger images only cost tokens

function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

async function downscale(dataUrl) {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = CAPTURE_MAX_EDGE / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) return dataUrl;
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return 'data:image/jpeg;base64,' + bufferToBase64(await blob.arrayBuffer());
}

async function captureTab(sender) {
    if (!sender.tab || !sender.tab.active) return { error: 'the tab is not active' };
    try {
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'jpeg', quality: 85 });
        return { dataUrl: await downscale(dataUrl).catch(() => dataUrl) };
    } catch (error) {
        const message = error.message || String(error);
        return { error: message, needsPermission: /all_urls|activeTab|permission/i.test(message) };
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === Naki.MSG.API_REQUEST) {
        apiRequest(message).then(sendResponse);
        return true;
    }
    if (message?.type === Naki.MSG.CAPTURE) {
        captureTab(sender).then(sendResponse);
        return true;
    }
    // A hotkey pressed inside a NetAcad iframe: the top frame owns the UI and does the work.
    if (message?.type === Naki.MSG.SOLVE_RELAY && sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, { type: Naki.MSG.SOLVE }, { frameId: 0 }).catch(() => { });
    }
});
