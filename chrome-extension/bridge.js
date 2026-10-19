// Runs on the Citation Checker page (localhost) and relays messages between the page
// and the extension's background worker.

const announce = () => window.postMessage({ source: 'citation-checker-ext', type: 'ready', version: chrome.runtime.getManifest().version }, '*');

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'citation-checker-app') return;
  const { type, id, url } = event.data;

  if (type === 'ping') return announce();

  if (type === 'fetch') {
    chrome.runtime.sendMessage({ type: 'fetch', url }, (result) => {
      const error = chrome.runtime.lastError?.message;
      window.postMessage({ source: 'citation-checker-ext', type: 'result', id, result: error ? { error } : result }, '*');
    });
  }
});

announce();
