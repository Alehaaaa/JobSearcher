/**
 * Kojima Productions: real-time, entirely browser-driven public GET fallback.
 *
 * The company's official careers job pages link to its HRMOS applicant board:
 *   https://hrmos.co/pages/2052996596448374784/jobs
 *
 * HRMOS publishes actual titles, posting URLs, English-language posting links,
 * and an individual office-location tag for every listing in its public HTML.
 * cors.dev anonymously proxies public GET/HEAD (not POST); Jina Reader is a
 * limited fallback if cors.dev is unreachable. No credentials, fake vacancies,
 * prebuilt listing data, scheduled scraping or centralized backend.
 *
 * Note: HRMOS has 38 genuine board listings as of 2026-10-13, whereas the
 * original Kojima site's custom POST viewloader exposes 35. Three verified
 * HRMOS-only vacancies must NOT be silently discarded to force count parity.
 * Jina Reader's Markdown drops individual location fields, so those become
 * unspecified rather than assigning every posting an invented location.
 */

export const KOJIMA_BOARD_URL = 'https://hrmos.co/pages/2052996596448374784/jobs';
const PROXY_URL = `https://proxy.cors.dev/${KOJIMA_BOARD_URL}`;
const JINA_URL = `https://r.jina.ai/${KOJIMA_BOARD_URL}`;
const EXPECTED_CAREERS_URL = 'https://www.kojimaproductions.jp/kjpviewloader/load';
const DEADLINE_MS = 18000;

function safeJobURL(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'hrmos.co' ||
        url.username || url.password || url.port || url.search || url.hash ||
        !/^\/pages\/2052996596448374784\/jobs\/[A-Za-z0-9]+$/.test(url.pathname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function englishTitle(headline) {
  const raw = String(headline || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  // HRMOS shows native and English titles as "日本語職名 / English Title".
  // Some titles, including the interpretation position, have no English
  // translation in the listing. Preserve the original rather than invent one.
  const separator = raw.lastIndexOf(' / ');
  return separator >= 0 ? raw.slice(separator + 3).trim() : raw;
}

function jobLocation(address) {
  const raw = String(address || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  // Only infer Tokyo when the *individual* public job card includes 東京都.
  // Never assume all future positions are in Tokyo.
  if (raw.includes('東京都')) return 'Tokyo, Japan';
  return raw;
}

function deduplicate(jobs) {
  const seen = new Set();
  return jobs.filter(job => {
    const key = job.link.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse the original, untouched HRMOS board HTML. The browser supplies
 * DOMParser; unit tests inject jsdom's DOMParser without changing this module.
 */
export function parseKojimaHRMOSHTML(html) {
  if (typeof DOMParser !== 'function') {
    throw new Error('Kojima HTML fallback requires a browser DOMParser');
  }
  const document = new DOMParser().parseFromString(html, 'text/html');
  const jobs = [];
  for (const card of document.querySelectorAll('li.pg-list-cassette')) {
    const anchor = card.querySelector('a[href]');
    const title = englishTitle(card.querySelector('h2')?.textContent);
    const japaneseDetail = safeJobURL(anchor?.getAttribute('href'));
    if (!japaneseDetail || !title) continue;
    const sourceText = card.querySelector('.pg-list-cassette-body')?.textContent || '';
    const englishMatch = /English\s*:\s*(https:\/\/hrmos\.co\/pages\/2052996596448374784\/jobs\/[A-Za-z0-9]+)/i.exec(sourceText);
    const englishDetail = safeJobURL(englishMatch?.[1]);
    const link = englishDetail || japaneseDetail;
    // Only expose a title and location obtained from this individual card.
    const location = jobLocation(card.querySelector('li.sg-tag-location')?.textContent);
    jobs.push({
      title,
      location,
      link,
      extraLink: '',
      source: 'Kojima Productions · HRMOS public GET via cors.dev',
      proxied: true,
    });
  }
  return deduplicate(jobs);
}

/**
 * Jina Reader's public Markdown retains HRMOS posting links and original
 * Japanese/English title headings, but omits structured job locations.
 */
export function parseKojimaJinaMarkdown(markdown) {
  const jobs = [];
  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (!/^\s*\*\s+##\s*\[/.test(line)) continue;
    const heading = /^\s*\*\s+##\s*\[(.*?)\s+English\s*:\s*(https:\/\/hrmos\.co\/pages\/2052996596448374784\/jobs\/[A-Za-z0-9]+).*\]\((https:\/\/hrmos\.co\/pages\/2052996596448374784\/jobs\/[A-Za-z0-9]+)\)\s*$/i.exec(line);
    if (!heading) continue;
    const title = englishTitle(heading[1]);
    const japaneseDetail = safeJobURL(heading[3]);
    const englishDetail = safeJobURL(heading[2]);
    if (!title || !japaneseDetail) continue;
    jobs.push({
      title,
      location: '', // Jina drops HRMOS per-job addresses.
      link: englishDetail || japaneseDetail,
      extraLink: '',
      source: 'Kojima Productions · HRMOS public GET via Jina Reader (location unavailable)',
      proxied: true,
    });
  }
  return deduplicate(jobs);
}

async function readPublicGET(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Public Kojima GET returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} studio - The exact Kojima studio configuration.
 * @returns {Promise<Array<{title:string,location:string,link:string,extraLink:string,source:string,proxied:boolean}>|null>}
 * Unsupported studio/config: null. Supported-but-inaccessible feed: throws.
 */
export async function fetchKojimaJobs(studio) {
  if (studio?.id !== 'kojimaproductions' ||
      studio.careers_url !== EXPECTED_CAREERS_URL) return null;

  let primaryError;
  try {
    const markup = await readPublicGET(PROXY_URL);
    const jobs = parseKojimaHRMOSHTML(markup);
    if (!jobs.length) throw new Error('HRMOS HTML has no verified vacancy cards');
    return jobs;
  } catch (error) {
    primaryError = error;
  }
  try {
    const markup = await readPublicGET(JINA_URL);
    const declaredURL = /^URL Source:\s*(\S+)\s*$/m.exec(markup)?.[1];
    if (declaredURL !== KOJIMA_BOARD_URL) throw new Error('Jina source URL did not match the official HRMOS board');
    const jobs = parseKojimaJinaMarkdown(markup);
    if (!jobs.length) throw new Error('Jina Markdown has no verified Kojima vacancy links');
    return jobs;
  } catch (error) {
    throw new Error(`Kojima public GET fallback unavailable: ${primaryError.message}; ${error.message}`, {
      cause: error,
    });
  }
}
