// Opens each citation link in a background tab of the user's own Chrome (so their VPN,
// logins and cookies apply), waits for it to finish loading, returns the rendered HTML
// and closes the tab.

const MAX_TABS = 3;
const LOAD_TIMEOUT = 45000;
const CHALLENGE = /just a moment|checking your browser|verify you are human|attention required|cf-chl|challenge-platform|captcha-delivery|ddos-guard|are you a robot/i;

let active = 0;
const queue = [];
const ourTabs = new Map(); // tabId -> { status }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

// alert()/confirm()/prompt() in a background tab freezes it until answered, so while we
// read a site we register mute-dialogs.js for that site at document_start (before any of
// its scripts run), and unregister it as soon as no read of that site is in progress.
const muteRefs = new Map(); // origin -> count

async function muteDialogsOn(origin) {
  const n = (muteRefs.get(origin) || 0) + 1;
  muteRefs.set(origin, n);
  if (n > 1) return;
  await chrome.scripting
    .registerContentScripts([{ id: `mute:${origin}`, matches: [`${origin}/*`], js: ['mute-dialogs.js'], runAt: 'document_start', world: 'MAIN', allFrames: true, persistAcrossSessions: false }])
    .catch(() => {});
}

async function unmuteDialogsOn(origin) {
  const n = (muteRefs.get(origin) || 1) - 1;
  if (n > 0) return muteRefs.set(origin, n);
  muteRefs.delete(origin);
  await chrome.scripting.unregisterContentScripts({ ids: [`mute:${origin}`] }).catch(() => {});
}

// clear leftovers if the worker restarted mid-read
chrome.runtime.onStartup.addListener(() => chrome.scripting.unregisterContentScripts().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => chrome.scripting.unregisterContentScripts().catch(() => {}));

// remember the HTTP status of the main page (tabs API doesn't expose it)
chrome.webRequest.onCompleted.addListener(
  ({ tabId, statusCode }) => {
    const t = ourTabs.get(tabId);
    if (t) t.status = statusCode;
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => id === tabId && info.status === 'complete' && done();
    const timer = setTimeout(done, LOAD_TIMEOUT);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && done()).catch(done);
  });
}

const readPage = (tabId) =>
  withTimeout(
    chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => ({ html: document.documentElement.outerHTML, title: document.title, url: location.href }),
      })
      .then(([r]) => r.result),
    8000,
    'Page is frozen (probably a popup dialog)',
  );

async function fetchInTab(url) {
  let tabId;
  const origin = new URL(url).origin;
  await muteDialogsOn(origin);
  try {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabId = tab.id;
    ourTabs.set(tabId, { status: null });
    await chrome.tabs.update(tabId, { url, muted: true });
    await sleep(300);
    await waitForLoad(tabId);
    await sleep(1500); // let JavaScript-built listings render

    let page = await readPage(tabId);
    // bot checks (Cloudflare etc.) usually clear by themselves in a real browser
    for (let i = 0; i < 6 && CHALLENGE.test(page.title + page.html.slice(0, 5000)); i++) {
      await sleep(2500);
      page = await readPage(tabId);
    }

    const status = ourTabs.get(tabId)?.status ?? 200;
    const challenged = CHALLENGE.test(page.title + page.html.slice(0, 5000));
    return { ok: status < 400 && !challenged, status, finalUrl: page.url, html: page.html, challenged };
  } catch (err) {
    // Chrome's own error pages (bad SSL certificate, DNS failure...) can't be read
    const chromeError = /error page|cannot access contents|chrome-error/i.test(err.message);
    return { error: chromeError ? 'Chrome showed an error page (e.g. invalid SSL certificate or site down)' : err.message, chromeError };
  } finally {
    ourTabs.delete(tabId);
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
    unmuteDialogsOn(origin);
  }
}

async function runQueued(url) {
  if (active >= MAX_TABS) await new Promise((r) => queue.push(r));
  active++;
  try {
    return await fetchInTab(url);
  } finally {
    active--;
    queue.shift()?.();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'fetch') return;
  runQueued(msg.url).then(sendResponse);
  return true; // keep the channel open for the async response
});
