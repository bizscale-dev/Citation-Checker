import { useEffect, useMemo, useRef, useState } from 'react';

const FIELDS = [
  { key: 'name', label: 'Business Name', placeholder: 'MacLock Locksmith Services LLC' },
  { key: 'phone', label: 'Phone', placeholder: '(417) 425-3167' },
  { key: 'email', label: 'Email', placeholder: 'jamcneely27@gmail.com' },
  { key: 'address', label: 'Address', placeholder: '123 Main St, Springfield, MO 65802', multiline: true },
];

const STATUS_LABEL = { match: 'Correct', partial: 'Close', mismatch: 'Wrong', absent: 'Not listed' };
const CONCURRENCY = 4;

const load = (k, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? fallback;
  } catch {
    return fallback;
  }
};

// ---- helper extension: reads pages in the user's own Chrome (VPN, logins, cookies) ----
const extPending = new Map();
let extSeq = 0;

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'citation-checker-ext' || e.data.type !== 'result') return;
  extPending.get(e.data.id)?.(e.data.result);
  extPending.delete(e.data.id);
});

function extFetch(url) {
  const id = ++extSeq;
  return new Promise((resolve) => {
    extPending.set(id, resolve);
    window.postMessage({ source: 'citation-checker-app', type: 'fetch', id, url }, '*');
    setTimeout(() => extPending.has(id) && (extPending.delete(id), resolve({ error: 'Your Chrome took too long (90s)' })), 90000);
  });
}

function useExtension() {
  const [version, setVersion] = useState(null);
  useEffect(() => {
    const onMsg = (e) => e.source === window && e.data?.source === 'citation-checker-ext' && e.data.type === 'ready' && setVersion(e.data.version);
    window.addEventListener('message', onMsg);
    window.postMessage({ source: 'citation-checker-app', type: 'ping' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);
  return version;
}

// ---- "Send to Checker" bookmark: no-install way to read a page in the user's own Chrome ----
// Run on a citation page that the app opened, it posts the page's HTML back to this app
// (window.opener, only to this exact origin) and closes the tab. If the site cut the link to
// the opener, it copies the page text so it can be pasted instead.
const bookmarkletCode = (origin) =>
  'javascript:' +
  encodeURIComponent(
    `(()=>{const d={source:'citation-checker-bookmarklet',url:location.href,title:document.title,html:document.documentElement.outerHTML};` +
      `if(window.opener){window.opener.postMessage(d,${JSON.stringify(origin)});document.title='Sent to Citation Checker';setTimeout(()=>window.close(),400);}` +
      `else{navigator.clipboard.writeText(document.body.innerText).then(()=>alert('This site blocked sending. The page text is copied: go back to the Citation Checker, click Paste text on this link and press Ctrl+V.'),()=>alert('Open this page with the Open in my Chrome button in the Citation Checker first.'));}})()`,
  );

function BookmarkletLink() {
  const ref = useRef(null);
  // set via the DOM: React refuses javascript: URLs in href
  useEffect(() => ref.current?.setAttribute('href', bookmarkletCode(window.location.origin)), []);
  return (
    <a ref={ref} className="bookmarklet" onClick={(e) => e.preventDefault()} title="Drag me to your bookmarks bar">
      📌 Send to Checker
    </a>
  );
}

async function callCheck(body) {
  const res = await fetch('/api/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Server error ${res.status}`);
  return res.json();
}

export default function App() {
  const [info, setInfo] = useState(() => load('cc.info', { name: '', phone: '', email: '', address: '' }));
  const [linksText, setLinksText] = useState(() => load('cc.links', ''));
  const [results, setResults] = useState({}); // url -> { loading, data, error }
  const [running, setRunning] = useState(false);
  const [pasteFor, setPasteFor] = useState(null);
  const [pasteText, setPasteText] = useState('');

  const extVersion = useExtension();
  const [mode, setMode] = useState(() => load('cc.mode', 'chrome')); // 'chrome' | 'server'
  const useMyChrome = Boolean(extVersion) && mode === 'chrome';
  // the checker's own hidden Chrome: separate profile, so no VPN / logins. Off unless chosen.
  const [serverChromeOpt, setServerChromeOpt] = useState(() => load('cc.serverChrome', false));
  const serverChrome = !useMyChrome && serverChromeOpt;
  useEffect(() => localStorage.setItem('cc.mode', JSON.stringify(mode)), [mode]);
  useEffect(() => localStorage.setItem('cc.serverChrome', JSON.stringify(serverChromeOpt)), [serverChromeOpt]);

  useEffect(() => localStorage.setItem('cc.info', JSON.stringify(info)), [info]);
  useEffect(() => localStorage.setItem('cc.links', JSON.stringify(linksText)), [linksText]);

  const links = useMemo(
    () => [...new Set(linksText.split(/\s+/).map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l)))],
    [linksText],
  );

  const hasInfo = Object.values(info).some((v) => v.trim());

  // `sentPage`: HTML the "Send to Checker" bookmark posted back from the user's own tab
  const checkOne = async (url, pastedText, sentPage) => {
    setResults((r) => ({ ...r, [url]: { loading: true } }));
    try {
      let page = sentPage;
      if (!page && !pastedText && useMyChrome) {
        page = await extFetch(url);
        // your Chrome couldn't show it (bad certificate, frozen tab...): let the server try instead
        if (page.error) page = undefined;
      }
      const data = await callCheck({ url, info, pastedText, page, serverChrome });
      setResults((r) => ({ ...r, [url]: { data } }));
    } catch (e) {
      setResults((r) => ({ ...r, [url]: { data: { readable: false, error: e.message } } }));
    }
  };

  const checkAll = async () => {
    setRunning(true);
    setResults({});
    const queue = [...links];
    const worker = async () => {
      while (queue.length) await checkOne(queue.shift());
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    setRunning(false);
  };

  // tabs we opened for the bookmark, so its message can be matched back to the right link
  const openedTabs = useRef(new Map()); // window -> link url
  const checkOneRef = useRef(checkOne);
  checkOneRef.current = checkOne;

  useEffect(() => {
    const onMsg = (e) => {
      if (e.data?.source !== 'citation-checker-bookmarklet' || typeof e.data.html !== 'string') return;
      const url = openedTabs.current.get(e.source);
      if (!url) return; // only accept pages this app opened
      openedTabs.current.delete(e.source);
      // the bookmark can't see the HTTP status, so recognise error pages by their title
      const m = (e.data.title || '').match(/\b(401|403|404|410|429|503)\b|forbidden|access denied|not found/i);
      const status = m ? Number(m[1]) || (/not found/i.test(m[0]) ? 404 : 403) : 200;
      checkOneRef.current(url, undefined, { ok: status < 400, status, finalUrl: e.data.url, html: e.data.html });
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const openInChrome = async (url) => {
    // a new tab in this browser = your own Chrome profile, with your VPN and logins.
    // Kept as window.opener so the "Send to Checker" bookmark can post the page back.
    if (!serverChrome) {
      const tab = window.open(url, '_blank');
      if (tab) openedTabs.current.set(tab, url);
      setResults((r) => (r[url]?.data ? { ...r, [url]: { ...r[url], waitingForBookmark: true } } : r));
      return;
    }
    const res = await fetch('/api/browser/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (!res.ok) window.open(url, '_blank');
  };

  // swap an owner/dead link for the public listing we found, keeping its result
  const useFoundLink = (oldUrl, newUrl) => {
    setLinksText((t) => t.split(oldUrl).join(newUrl));
    setResults((r) => {
      const { [oldUrl]: moved, ...rest } = r;
      const { publicUrl, foundVia, originalProblem, ...data } = moved.data;
      return { ...rest, [newUrl]: { data } };
    });
  };

  const submitPaste = async () => {
    const url = pasteFor;
    setPasteFor(null);
    await checkOne(url, pasteText);
    setPasteText('');
  };

  const summary = useMemo(() => {
    const s = { ok: 0, bad: 0, unreadable: 0 };
    for (const r of Object.values(results)) {
      if (!r.data) continue;
      if (r.data.missing) s.bad++;
      else if (!r.data.readable) s.unreadable++;
      else if (Object.values(r.data.checks).some((c) => c && c.status === 'mismatch')) s.bad++;
      else s.ok++;
    }
    return s;
  }, [results]);

  return (
    <div className="app">
      <header>
        <h1>Citation Checker</h1>
        <p>Checks each citation page for your business name, phone, email and address.</p>
      </header>

      <main>
        <section className="panel info-panel">
          <h2>Business Info</h2>
          {FIELDS.map((f) => (
            <label key={f.key} className="field">
              <span>{f.label}</span>
              {f.multiline ? (
                <textarea
                  rows={2}
                  value={info[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => setInfo({ ...info, [f.key]: e.target.value })}
                />
              ) : (
                <input
                  value={info[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => setInfo({ ...info, [f.key]: e.target.value })}
                />
              )}
            </label>
          ))}
          <p className="hint">Leave a field empty to skip checking it.</p>
        </section>

        <section className="panel links-panel">
          <h2>Citation Links</h2>
          <textarea
            className="links-input"
            rows={5}
            value={linksText}
            placeholder={'Paste one link per line\nhttps://findmetop.com/listing/...\nhttps://www.yelp.com/biz/...'}
            onChange={(e) => setLinksText(e.target.value)}
          />
          <div className={`fetch-mode ${extVersion ? 'on' : ''}`}>
            {extVersion ? (
              <>
                <span>Read pages with:</span>
                <label>
                  <input type="radio" checked={mode === 'chrome'} onChange={() => setMode('chrome')} /> My Chrome (VPN + logins)
                </label>
                <label>
                  <input type="radio" checked={mode === 'server'} onChange={() => setMode('server')} /> Server
                </label>
              </>
            ) : (
              <span>
                Pages are read by the server. For links the server can't open (403 / blocked), click{' '}
                <b>Open in my Chrome</b> on that link, then click the <BookmarkletLink /> bookmark on the page that opens. One-time
                setup: drag that button to your bookmarks bar (Ctrl+Shift+B shows the bar).{' '}
                <span className="muted">Optional: the helper extension does this automatically.</span>
              </span>
            )}
            {!useMyChrome && (
              <label title="Uses a separate hidden Chrome with its own profile: helps with bot checks, but has NO VPN and NO logins">
                <input type="checkbox" checked={serverChromeOpt} onChange={(e) => setServerChromeOpt(e.target.checked)} /> Retry blocked
                pages in a separate hidden Chrome (no VPN)
              </label>
            )}
          </div>
          <div className="actions">
            <button onClick={checkAll} disabled={running || !links.length || !hasInfo}>
              {running ? 'Checking…' : `Check ${links.length || ''} link${links.length === 1 ? '' : 's'}`}
            </button>
            {Object.keys(results).length > 0 && (
              <div className="summary">
                <span className="pill match">{summary.ok} correct</span>
                <span className="pill mismatch">{summary.bad} with errors</span>
                <span className="pill unreadable">{summary.unreadable} couldn't read</span>
              </div>
            )}
          </div>

          <div className="results">
            {links.map((url) => {
              const r = results[url];
              const d = r?.data;
              const hasError = d?.missing || (d?.readable && Object.values(d.checks).some((c) => c && c.status === 'mismatch'));
              return (
                <article key={url} className={`result ${!r ? '' : r.loading ? 'loading' : hasError ? 'bad' : !d.readable ? 'unreadable' : 'good'}`}>
                  <div className="result-head">
                    <a href={url} target="_blank" rel="noreferrer" title={url}>
                      {d?.title || url}
                    </a>
                    <div className="result-actions">
                      {d?.source === 'pasted' && <span className="tag">pasted text</span>}
                      {d?.fetchedWith === 'your-chrome' && <span className="tag">your Chrome</span>}
                      {d?.fetchedWith === 'browser' &&<span className="tag" title="Plain request was blocked, so this page was loaded in real Chrome">via Chrome</span>}
                      {d && !d.readable && !d.missing && (
                        <button
                          className={`small ${useMyChrome || serverChrome ? 'ghost' : ''}`}
                          onClick={() => openInChrome(url)}
                          title="Opens the link in a new tab of your Chrome (your VPN and logins). Then click the Send to Checker bookmark there"
                        >
                          Open in my Chrome
                        </button>
                      )}
                      <button className="small ghost" onClick={() => checkOne(url)} disabled={r?.loading || !hasInfo}>
                        Recheck
                      </button>
                      <button className="small ghost" onClick={() => setPasteFor(url)} disabled={r?.loading}>
                        Paste text
                      </button>
                    </div>
                  </div>
                  <div className="url">{url}</div>

                  {!r && <div className="muted">Not checked yet</div>}
                  {r?.loading && <div className="muted">Fetching page… (owner or dead links also search the site for the public listing)</div>}
                  {d?.publicUrl && (
                    <div className="found-msg">
                      <div>
                        {d.originalProblem}. Found the public listing via {d.foundVia}:{' '}
                        <a href={d.publicUrl} target="_blank" rel="noreferrer">
                          {d.publicUrl}
                        </a>
                      </div>
                      <button className="small" onClick={() => useFoundLink(url, d.publicUrl)}>
                        Use this link
                      </button>
                    </div>
                  )}
                  {d?.missing && <div className="missing-msg">{d.error}</div>}
                  {d && !d.readable && !d.missing && (
                    <div className="unreadable-msg">
                      Couldn't read this page: {d.error.replace(/\.?$/, '.')}
                      <br />
                      {r.waitingForBookmark ? (
                        <b>Waiting: on the tab that opened, click the 📌 Send to Checker bookmark (VPN on). It checks automatically.</b>
                      ) : (
                        <>
                          Fix: click <b>Open in my Chrome</b>, then click the <b>📌 Send to Checker</b> bookmark on that page. Or
                          copy the page (Ctrl+A, Ctrl+C) and use <b>Paste text</b>.
                        </>
                      )}
                    </div>
                  )}
                  {d?.warning && <div className="warning">{d.warning}</div>}
                  {d?.readable && (
                    <div className="checks">
                      {FIELDS.map((f) => {
                        const c = d.checks[f.key];
                        if (!c) return null;
                        return (
                          <div key={f.key} className={`check ${c.status}`}>
                            <div className="check-label">
                              <span>{f.label}</span>
                              <b>{STATUS_LABEL[c.status]}</b>
                            </div>
                            <div className="check-value">{info[f.key]}</div>
                            {c.note && <div className="check-note">{c.note}</div>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </article>
              );
            })}
            {!links.length && <div className="muted empty">Add citation links above to get started.</div>}
          </div>
        </section>
      </main>

      {pasteFor && (
        <div className="modal-backdrop" onClick={() => setPasteFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Paste page text</h3>
            <p className="muted">{pasteFor}</p>
            <textarea
              autoFocus
              rows={12}
              value={pasteText}
              placeholder="Open the listing, press Ctrl+A then Ctrl+C, and paste here"
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div className="actions">
              <button className="ghost" onClick={() => setPasteFor(null)}>
                Cancel
              </button>
              <button onClick={submitPaste} disabled={!pasteText.trim()}>
                Check pasted text
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
