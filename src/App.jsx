import { useEffect, useMemo, useState } from 'react';
import { parseDetails } from './parseDetails.js';
import {
  IconAlert,
  IconBuilding,
  IconCheck,
  IconChrome,
  IconClipboard,
  IconExternal,
  IconGoogle,
  IconLink,
  IconLock,
  IconMail,
  IconMinus,
  IconPhone,
  IconPin,
  IconRefresh,
  IconSearch,
  IconSparkle,
  IconX,
  Logo,
  Spinner,
} from './icons.jsx';

const FIELDS = [
  { key: 'name', label: 'Business Name', icon: IconBuilding },
  { key: 'phone', label: 'Phone', icon: IconPhone },
  { key: 'email', label: 'Email', icon: IconMail },
  { key: 'address', label: 'Address', icon: IconPin },
  { key: 'gmb', label: 'GMB Link', icon: IconGoogle },
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

// the server couldn't get the page (403 / bot check / empty), as opposed to a real answer
const BLOCKED_STATUS = [401, 403, 406, 429, 503, 520, 521, 522, 523, 524, 525, 526, 530];
const serverWasBlocked = (d) => !d.readable && !d.missing && (d.challenged || BLOCKED_STATUS.includes(d.httpStatus) || d.kind === 'unreadable');

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
  // one free-form box; fields are detected from it, and any detected value can be corrected by hand
  const [details, setDetails] = useState(() => {
    const saved = load('cc.details', null);
    if (saved !== null) return saved;
    // carry over info saved by the older separate-fields version
    const old = load('cc.info', {});
    return ['name', 'phone', 'email', 'address', 'gmb'].map((k) => old[k]).filter(Boolean).join('\n');
  });
  const [overrides, setOverrides] = useState(() => load('cc.overrides', {}));
  const info = useMemo(() => ({ ...parseDetails(details), ...overrides }), [details, overrides]);
  useEffect(() => localStorage.setItem('cc.details', JSON.stringify(details)), [details]);
  useEffect(() => localStorage.setItem('cc.overrides', JSON.stringify(overrides)), [overrides]);
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

  useEffect(() => localStorage.setItem('cc.links', JSON.stringify(linksText)), [linksText]);

  const links = useMemo(
    () => [...new Set(linksText.split(/\s+/).map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l)))],
    [linksText],
  );

  const hasInfo = Object.values(info).some((v) => v.trim());

  // Every link goes to the server first. Only if the server is blocked (403, bot check,
  // empty page) is it re-read in a background tab of the user's own Chrome (VPN, logins).
  const checkOne = async (url, pastedText) => {
    setResults((r) => ({ ...r, [url]: { loading: true } }));
    try {
      let data = await callCheck({ url, info, pastedText, serverChrome });
      if (!pastedText && useMyChrome && serverWasBlocked(data)) {
        setResults((r) => ({ ...r, [url]: { loading: true, inYourChrome: true } }));
        const page = await extFetch(url);
        // your Chrome couldn't show it either (bad certificate, frozen tab...): keep the server's result
        if (!page.error) data = await callCheck({ url, info, page });
      }
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

  const openInChrome = async (url) => {
    // a new tab in this browser = your own Chrome profile, with your VPN and logins
    if (!serverChrome) return window.open(url, '_blank');
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

  const checkedCount = Object.values(results).filter((r) => r.data).length;
  const loadingCount = Object.values(results).filter((r) => r.loading).length;
  const progress = links.length ? Math.round((checkedCount / links.length) * 100) : 0;

  return (
    <div className="app">
      <header className="hero">
        <div className="hero-inner">
          <div className="brand">
            <Logo size={44} />
            <div>
              <h1>Citation Checker</h1>
              <p>Verify your business info across every directory listing, in one click.</p>
            </div>
          </div>
          <div className={`conn ${extVersion ? 'on' : 'off'}`} title={extVersion ? `Helper extension v${extVersion}` : 'Helper extension not detected'}>
            <IconChrome size={16} />
            {extVersion ? 'Chrome connected' : 'Chrome not connected'}
            <span className="dot" />
          </div>
        </div>
      </header>

      <main>
        <section className="panel info-panel">
          <div className="panel-head">
            <span className="panel-icon violet">
              <IconBuilding />
            </span>
            <div>
              <h2>Business Details</h2>
              <p className="panel-sub">Paste everything, it sorts itself out</p>
            </div>
          </div>
          <textarea
            className="details-input"
            rows={6}
            value={details}
            placeholder={'e.g.\nMacLock Locksmith Services LLC (417) 425-3167 jamcneely27@gmail.com\n123 Main St, Springfield, MO 65802\nhttps://maps.app.goo.gl/...'}
            onChange={(e) => {
              setDetails(e.target.value);
              setOverrides({}); // new text: detect everything again
            }}
          />

          <div className="detected-head">
            <IconSparkle size={14} /> Detected
            <span className="detected-count">
              {FIELDS.filter((f) => info[f.key]).length}/{FIELDS.length}
            </span>
          </div>
          <div className="detected-list">
            {FIELDS.map((f) => {
              const edited = overrides[f.key] !== undefined;
              const Icon = f.icon;
              return (
                <label key={f.key} className={`detected ${info[f.key] ? 'found' : 'missing'}`}>
                  <span className="detected-icon">
                    <Icon size={15} />
                  </span>
                  <span className="detected-body">
                    <span className="detected-label">
                      {f.label}
                      {edited && (
                        <button type="button" className="link-button" onClick={() => setOverrides(({ [f.key]: _, ...rest }) => rest)}>
                          undo edit
                        </button>
                      )}
                    </span>
                    <input
                      value={info[f.key]}
                      placeholder="Not found, won't be checked"
                      onChange={(e) => setOverrides((o) => ({ ...o, [f.key]: e.target.value }))}
                    />
                  </span>
                  <span className="detected-mark">{info[f.key] ? <IconCheck size={14} /> : <IconMinus size={14} />}</span>
                </label>
              );
            })}
          </div>
          <p className="hint">Something detected wrong? Fix it right in the list. Empty items are skipped.</p>
        </section>

        <section className="panel links-panel">
          <div className="panel-head">
            <span className="panel-icon blue">
              <IconLink />
            </span>
            <div>
              <h2>Citation Links</h2>
              <p className="panel-sub">One link per line</p>
            </div>
            {links.length > 0 && <span className="count-chip">{links.length} links</span>}
          </div>
          <textarea
            className="links-input"
            rows={5}
            value={linksText}
            placeholder={'https://findmetop.com/listing/...\nhttps://www.yelp.com/biz/...'}
            onChange={(e) => setLinksText(e.target.value)}
          />

          {extVersion ? (
            <div className="mode">
              <span className="mode-label">Blocked links (403)</span>
              <div className="segmented">
                <button className={mode === 'chrome' ? 'active' : ''} onClick={() => setMode('chrome')}>
                  Retry in my Chrome (VPN)
                </button>
                <button className={mode === 'server' ? 'active' : ''} onClick={() => setMode('server')}>
                  Server only
                </button>
              </div>
            </div>
          ) : (
            <div className="notice">
              <IconLock size={18} />
              <div>
                <b>Connect your Chrome to read blocked (403) links with your VPN.</b> Open <code>chrome://extensions</code>, turn on{' '}
                <b>Developer mode</b>, click <b>Load unpacked</b> and pick the <code>chrome-extension</code> folder, then reload this
                page. Already installed? Click <b>reload</b> on "Citation Checker Helper" (v1.1.0+).
                <label className="inline-check" title="Uses a separate hidden Chrome with its own profile: helps with bot checks, but has NO VPN and NO logins">
                  <input type="checkbox" checked={serverChromeOpt} onChange={(e) => setServerChromeOpt(e.target.checked)} /> Retry blocked
                  pages in a separate hidden Chrome (no VPN, local only)
                </label>
              </div>
            </div>
          )}

          <div className="actions">
            <button className="primary" onClick={checkAll} disabled={running || !links.length || !hasInfo}>
              {running ? (
                <>
                  <Spinner /> Checking {checkedCount}/{links.length}
                </>
              ) : (
                <>
                  <IconSearch size={17} /> Check {links.length || ''} link{links.length === 1 ? '' : 's'}
                </>
              )}
            </button>
            {!hasInfo && <span className="muted">Add business details first</span>}
          </div>

          {(checkedCount > 0 || loadingCount > 0) && (
            <div className="stats">
              <div className="stat">
                <span className="stat-num">
                  {checkedCount}
                  <small>/{links.length}</small>
                </span>
                <span className="stat-label">Checked</span>
              </div>
              <div className="stat good">
                <span className="stat-num">{summary.ok}</span>
                <span className="stat-label">All correct</span>
              </div>
              <div className="stat bad">
                <span className="stat-num">{summary.bad}</span>
                <span className="stat-label">With errors</span>
              </div>
              <div className="stat gray">
                <span className="stat-num">{summary.unreadable}</span>
                <span className="stat-label">Couldn&apos;t read</span>
              </div>
              <div className="progress" aria-label={`${progress}% checked`}>
                <span style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          <div className="results">
            {links.map((url) => {
              const r = results[url];
              const d = r?.data;
              const hasError = d?.missing || (d?.readable && Object.values(d.checks).some((c) => c && c.status === 'mismatch'));
              const state = !r ? 'pending' : r.loading ? 'loading' : hasError ? 'bad' : !d.readable ? 'unreadable' : 'good';
              const badge = {
                pending: ['Not checked', null],
                loading: [r?.inYourChrome ? 'In your Chrome…' : 'Checking…', <Spinner key="s" size={12} />],
                good: ['All correct', <IconCheck key="i" size={13} />],
                bad: [d?.missing ? 'Listing gone' : 'Has errors', <IconX key="i" size={13} />],
                unreadable: ["Couldn't read", <IconAlert key="i" size={13} />],
              }[state];
              let host = '';
              try {
                host = new URL(url).hostname.replace(/^www\./, '');
              } catch {}
              return (
                <article key={url} className={`result ${state}`}>
                  <div className="result-head">
                    <img className="site-icon" src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`} alt="" loading="lazy" />
                    <div className="result-title">
                      <a href={url} target="_blank" rel="noreferrer" title={url}>
                        {d?.title || host || url}
                      </a>
                      <div className="url">{url}</div>
                    </div>
                    <span className={`badge ${state}`}>
                      {badge[1]}
                      {badge[0]}
                    </span>
                  </div>

                  {(d?.source === 'pasted' || d?.fetchedWith === 'your-chrome' || d?.fetchedWith === 'browser') && (
                    <div className="tags">
                      {d?.source === 'pasted' && <span className="tag">pasted text</span>}
                      {d?.fetchedWith === 'your-chrome' && <span className="tag violet">read in your Chrome</span>}
                      {d?.fetchedWith === 'browser' && <span className="tag">via hidden Chrome</span>}
                    </div>
                  )}

                  {r?.loading && (
                    <div className="loading-line">
                      {r.inYourChrome
                        ? 'Server was blocked, reading it in your Chrome (VPN)…'
                        : 'Fetching page… (owner or dead links also search the site for the public listing)'}
                    </div>
                  )}
                  {d?.publicUrl && (
                    <div className="msg info">
                      <div>
                        {d.originalProblem}. Found the public listing via {d.foundVia}:{' '}
                        <a href={d.publicUrl} target="_blank" rel="noreferrer">
                          {d.publicUrl}
                        </a>
                      </div>
                      <button className="small primary" onClick={() => useFoundLink(url, d.publicUrl)}>
                        Use this link
                      </button>
                    </div>
                  )}
                  {d?.missing && (
                    <div className="msg danger">
                      <IconX size={16} />
                      <div>{d.error}</div>
                    </div>
                  )}
                  {d && !d.readable && !d.missing && (
                    <div className="msg neutral">
                      <IconAlert size={16} />
                      <div>
                        {d.error.replace(/\.?$/, '.')}{' '}
                        <span className="muted">
                          {useMyChrome
                            ? 'Turn your VPN on and click Recheck, or copy the page (Ctrl+A, Ctrl+C) and use Paste text.'
                            : 'Connect your Chrome (see above) so blocked links are read with your VPN, or copy the page and use Paste text.'}
                        </span>
                      </div>
                    </div>
                  )}
                  {d?.warning && (
                    <div className="msg warn">
                      <IconAlert size={16} />
                      <div>{d.warning}</div>
                    </div>
                  )}
                  {d?.readable && (
                    <div className="checks">
                      {FIELDS.map((f) => {
                        const c = d.checks[f.key];
                        if (!c) return null;
                        const Icon = f.icon;
                        return (
                          <div key={f.key} className={`check ${c.status}`}>
                            <div className="check-label">
                              <span className="check-name">
                                <Icon size={14} /> {f.label}
                              </span>
                              <b className="check-status">{STATUS_LABEL[c.status]}</b>
                            </div>
                            <div className="check-value">{info[f.key]}</div>
                            {c.note && <div className="check-note">{c.note}</div>}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="result-actions">
                    {d &&
                      !d.readable &&
                      !d.missing &&
                      (serverChrome ? (
                        <button className="small ghost" onClick={() => openInChrome(url)} title="Opens the page in the checker's hidden Chrome">
                          <IconExternal size={13} /> Open in Chrome
                        </button>
                      ) : (
                        // a real link, not window.open(): popup blockers never stop a clicked link
                        <a className="button small ghost" href={url} target="_blank" rel="noopener noreferrer" title="Opens the link in a new tab of your Chrome">
                          <IconExternal size={13} /> Open in Chrome
                        </a>
                      ))}
                    <button className="small ghost" onClick={() => checkOne(url)} disabled={r?.loading || !hasInfo}>
                      <IconRefresh size={13} /> Recheck
                    </button>
                    <button className="small ghost" onClick={() => setPasteFor(url)} disabled={r?.loading}>
                      <IconClipboard size={13} /> Paste text
                    </button>
                  </div>
                </article>
              );
            })}
            {!links.length && (
              <div className="empty">
                <Logo size={56} />
                <h3>No links yet</h3>
                <p>Paste your citation links above, one per line, then hit Check.</p>
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="footer">Citation Checker · name, phone, email, address and GMB checked on every listing</footer>

      {pasteFor && (
        <div className="modal-backdrop" onClick={() => setPasteFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              <IconClipboard size={18} /> Paste page text
            </h3>
            <p className="muted modal-url">{pasteFor}</p>
            <textarea
              autoFocus
              rows={12}
              value={pasteText}
              placeholder="Open the listing, press Ctrl+A then Ctrl+C, and paste here"
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div className="actions end">
              <button className="ghost" onClick={() => setPasteFor(null)}>
                Cancel
              </button>
              <button className="primary" onClick={submitPaste} disabled={!pasteText.trim()}>
                Check pasted text
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
