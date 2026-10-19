// Given an owner/edit (or dead) citation link, try to locate the business's public
// listing page on the same directory site.
//
// Strategies, cheapest first:
//   1. the site's own search (forms on the homepage + common search URLs)
//   2. guessing listing URLs from the business name slug
//   3. the site's sitemaps
// Every candidate is fetched and only accepted if the business name is on the page.

import * as cheerio from 'cheerio';

const STOP = new Set(['llc', 'inc', 'co', 'corp', 'ltd', 'the', 'and', 'of', 'services', 'service', 'company', 'pllc', 'llp']);

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const nameTokens = (name) =>
  slugify(name)
    .split('-')
    .filter((t) => t && !STOP.has(t));

// share of the business-name tokens that appear in a string (slug, anchor text, title)
function tokenScore(tokens, s) {
  if (!tokens.length) return 0;
  const hay = `-${slugify(s || '')}-`;
  return tokens.filter((t) => hay.includes(`-${t}-`) || (t.length === 1 && hay.includes(t))).length / tokens.length;
}

const SEARCH_PARAMS = ['q', 's', 'keyword', 'keywords', 'search', 'query', 'search_keywords', 'term'];
const COMMON_SEARCH_PATHS = ['/search_results?q=', '/?s=', '/search?q=', '/search.php?q=', '/search/?q=', '/listings/?search_keywords=', '/?post_type=listing&s=', '/directory/?s='];
const SLUG_PREFIXES = ['listing', 'listings', 'business', 'businesses', 'company', 'companies', 'directory', 'directory/listing', 'biz', 'place', 'places', 'profile', 'profiles', 'members', 'job_listing', 'listing-item', 'lst', 'b', 'local', 'store'];

const BAD_PATH = /\/(search|login|register|signup|sign-up|add-listing|wp-admin|my-?account|dashboard|cart|checkout|category|categories|tag|tags|page|author|feed)\b|[?&](s|q|action)=|\.(jpg|png|gif|pdf|css|js|xml)$/i;

export async function findPublicListing({ url, name, fetchHtml, checkName, slow = false, budgetMs = 45000 }) {
  const started = Date.now();
  const timeLeft = () => budgetMs - (Date.now() - started);
  const origin = new URL(url).origin;
  const host = new URL(url).hostname.replace(/^www\./, '');
  const tokens = nameTokens(name);
  if (!tokens.length) return { found: false, tried: [], reason: 'Business name is empty' };

  const candidates = new Map(); // url -> { score, via }
  const tried = [];

  const sameHost = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '') === host;
    } catch {
      return false;
    }
  };

  const addCandidate = (href, text, via) => {
    let abs;
    try {
      abs = new URL(href, origin);
    } catch {
      return;
    }
    abs.hash = '';
    const u = abs.href;
    if (!sameHost(u) || u === url || BAD_PATH.test(abs.pathname + abs.search)) return;
    const score = Math.max(tokenScore(tokens, decodeURIComponent(abs.pathname)), tokenScore(tokens, text) * 0.9);
    if (score < 0.6) return;
    // prefer the listing itself over sub-pages like /listing/x/connect or /listing/x/reviews
    const depthPenalty = abs.pathname.split('/').filter(Boolean).length * 0.01;
    const prev = candidates.get(u);
    if (!prev || prev.score < score - depthPenalty) candidates.set(u, { score: score - depthPenalty, via });
  };

  const safeGet = async (u, ms = 12000) => {
    if (timeLeft() < 2000) return null;
    try {
      return await fetchHtml(u, Math.min(ms, timeLeft()));
    } catch {
      return null;
    }
  };

  const harvestLinks = (html, via) => {
    const $ = cheerio.load(html);
    $('a[href]').each((_, el) => addCandidate($(el).attr('href'), $(el).text(), via));
  };

  // ---- 1. site search ----
  const searchUrls = new Set();
  const home = await safeGet(origin + '/');
  if (home?.html) {
    const $ = cheerio.load(home.html);
    $('form').each((_, f) => {
      const method = ($(f).attr('method') || 'get').toLowerCase();
      if (method !== 'get') return;
      const action = new URL($(f).attr('action') || '/', origin);
      if (!sameHost(action.href)) return;
      const textInput = $(f).find('input[type="search"], input[type="text"], input:not([type])').first().attr('name');
      const isSearchy = /search|find|result/i.test(action.pathname) || /search/i.test($(f).attr('class') || '') || textInput;
      if (!isSearchy) return;
      const params = textInput ? [textInput] : SEARCH_PARAMS.slice(0, 2);
      for (const p of params) {
        const su = new URL(action.href);
        $(f)
          .find('input[type="hidden"][name]')
          .each((_, h) => su.searchParams.set($(h).attr('name'), $(h).attr('value') || ''));
        su.searchParams.set(p, name);
        searchUrls.add(su.href);
      }
    });
    harvestLinks(home.html, 'homepage');
  }
  for (const p of COMMON_SEARCH_PATHS) searchUrls.add(origin + p + encodeURIComponent(name));

  const searchList = [...searchUrls].slice(0, slow ? 4 : 10);
  await Promise.all(
    searchList.map(async (su) => {
      tried.push(su);
      const r = await safeGet(su);
      if (r?.html) harvestLinks(r.html, 'site search');
    }),
  );

  // ---- 2. slug guesses ----
  const verified = await verifyCandidates();
  if (verified) return verified;

  const slugs = [...new Set([slugify(name), tokens.join('-')])];
  const guessUrls = SLUG_PREFIXES.flatMap((p) => slugs.flatMap((s) => [`${origin}/${p}/${s}/`, `${origin}/${p}/${s}`])).slice(0, slow ? 6 : undefined);
  await Promise.all(
    guessUrls.map(async (gu) => {
      const r = await safeGet(gu, 8000);
      if (r?.ok && r.html && sameHost(r.finalUrl)) addCandidate(r.finalUrl, '', 'URL guess');
    }),
  );
  const fromGuess = await verifyCandidates();
  if (fromGuess) return fromGuess;

  // ---- 3. sitemaps ----
  const sitemapQueue = [];
  const robots = await safeGet(origin + '/robots.txt', 8000);
  for (const m of robots?.html?.match(/^\s*sitemap:\s*(\S+)/gim) || []) sitemapQueue.push(m.replace(/^\s*sitemap:\s*/i, ''));
  sitemapQueue.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`);
  const seenMaps = new Set();
  while (sitemapQueue.length && seenMaps.size < (slow ? 6 : 25) && timeLeft() > 4000) {
    const sm = sitemapQueue.shift();
    if (seenMaps.has(sm)) continue;
    seenMaps.add(sm);
    const r = await safeGet(sm, 10000);
    if (!r?.ok || !/<(urlset|sitemapindex)/i.test(r.html || '')) continue;
    tried.push(sm);
    const locs = [...r.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(r.html)) {
      // look at listing-ish sitemaps first
      locs.sort((a, b) => Number(/list|business|place|compan|director|member|profile/i.test(b)) - Number(/list|business|place|compan|director|member|profile/i.test(a)));
      sitemapQueue.push(...locs);
    } else {
      for (const l of locs) addCandidate(l, '', 'sitemap');
    }
  }
  const fromSitemap = await verifyCandidates();
  if (fromSitemap) return fromSitemap;

  return { found: false, tried, reason: 'No public listing for this business name found on the site' };

  // fetch the best-scoring unverified candidates and keep the first that really is this business
  async function verifyCandidates() {
    const ranked = [...candidates.entries()].filter(([, c]) => !c.checked).sort((a, b) => b[1].score - a[1].score).slice(0, 6);
    for (const [cu, c] of ranked) {
      c.checked = true;
      const r = await safeGet(cu);
      if (!r?.ok || !r.html) continue;
      const $ = cheerio.load(r.html);
      const title = $('title').first().text();
      const h1 = $('h1').first().text();
      const text = $('body').text();
      const nameOnPage = checkName(name, text);
      const headingScore = Math.max(tokenScore(tokens, title), tokenScore(tokens, h1));
      if (nameOnPage?.status === 'match' && (headingScore >= 0.6 || c.score >= 0.8)) {
        return { found: true, publicUrl: r.finalUrl || cu, via: c.via, html: r.html, status: r.status };
      }
    }
    return null;
  }
}
