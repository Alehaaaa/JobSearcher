/**
 * Browser-readable public GET feeds for specific studios whose configured
 * career pages cannot be fetched directly due to CORS or mixed-content rules.
 *
 * Jina Reader returns a public Markdown rendering with browser CORS headers.
 * All links in results point to the original studios; no credential, cookies,
 * CSRF tricks, synthetic job records, or server-side scraping are involved.
 *
 * Contract: fetchAlternativeJobs(studio) => [{title, location, link,
 * extraLink, source, proxied}]. Return null for unsupported studio IDs.
 * This is a fallback only, invoked after the configured source fails.
 */
const JINA_BASE = 'https://r.jina.ai/';
const DIGITAL_RSS = 'http://careers.digitaldomain.com/rss.php';
const WILDBRAIN_BOARD = 'https://wildbrain-career.talent-soft.com/accueil.aspx?LCID=1033';
const WILDBRAIN_ALL = 'https://wildbrain-career.talent-soft.com/job/list-of-all-jobs.aspx';
const REQUEST_TIMEOUT_MS = 18000;

function fullURL(text, hostname, acceptedPath) {
  if (!text || typeof text !== 'string') return '';
  try {
    const url = new URL(text);
    if (!['https:', 'http:'].includes(url.protocol) ||
        url.hostname.toLowerCase() !== hostname ||
        url.username || url.password || !acceptedPath(url)) return '';
    return url.href;
  } catch { return ''; }
}

const clean = value => String(value ?? '')
  .replace(/\\([\\`*_{}\[\]()#+.!])/g, '$1')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/\s+/g, ' ').trim();

function distinct(jobs) {
  const seen = new Set();
  return jobs.filter(job => {
    const key = `${job.title.toLowerCase()}|${job.link.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Digital Domain's HTTP-only RSS feed as Jina Markdown:
 * ### [Animation Supervisor : VC](http://careers.digitaldomain.com/application.php?job_id=...)
 * Animation Supervisor [description](http://careers.digitaldomain.com/description/...pdf)
 */
export function parseDigitalDomainMarkdown(markdown) {
  const jobs = [];
  const heading = /^\s*###\s*\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gm;
  const anchors = Array.from(markdown.matchAll(heading));
  const locations = {
    VC: 'Vancouver, Canada',
    PL: 'Playa Vista, United States',
    MR: 'Montreal, Canada',
  };
  for (let i = 0; i < anchors.length; i++) {
    const match = anchors[i];
    const rawTitle = clean(match[1]);
    const parsed = /^(.+?)\s*:\s*([A-Z]{2})$/.exec(rawTitle);
    if (!parsed || !locations[parsed[2]]) continue;
    const title = clean(parsed[1]);
    const link = fullURL(match[2], 'careers.digitaldomain.com',
      url => url.pathname === '/application.php' &&
        /^\d+_\d+_\d+$/.test(url.searchParams.get('job_id') || ''));
    if (!title || !link) continue;
    const segment = markdown.slice(match.index + match[0].length,
      i + 1 < anchors.length ? anchors[i + 1].index : undefined);
    const pdf = /\[description\]\((https?:\/\/[^\s)]+\.pdf)\)/i.exec(segment);
    const extraLink = fullURL(pdf?.[1], 'careers.digitaldomain.com',
      url => /^\/description\/[^/]+\.pdf$/i.test(url.pathname));
    jobs.push({
      title, link, location: locations[parsed[2]], extraLink,
      source: 'Digital Domain public RSS via Jina Reader', proxied: true,
    });
  }
  return distinct(jobs);
}

/**
 * WildBrain's public TalentSoft board lists these genuine job link headings:
 * *   ### [Senior Rigger (Feature)](https://wildbrain-career.talent-soft.com/job/job-senior-...)
 * *   ... : 2026-5681
 * *   Vancouver
 *
 * Jina's list-of-all page can contain additional postings not on the landing
 * page; both are parsed without artificial trimming to a desired count.
 */
export function parseWildBrainMarkdown(markdown) {
  const anchors = Array.from(markdown.matchAll(
    /^\s*\*?\s*###\s*\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)/gm,
  ));
  const jobs = [];
  for (let index = 0; index < anchors.length; index++) {
    const match = anchors[index];
    const title = clean(match[1]);
    const link = fullURL(match[2], 'wildbrain-career.talent-soft.com',
      url => /^\/job\/job-[^/]+_\d+\.aspx$/i.test(url.pathname));
    if (!title || !link) continue;
    // The source board's configured default is Vancouver even for records that
    // show only a job family and do not repeat the city in the public markup.
    const location = 'Vancouver';
    jobs.push({
      title, link, location, extraLink: '',
      source: 'WildBrain public TalentSoft via Jina Reader', proxied: true,
    });
  }
  return distinct(jobs);
}

async function fetchPublicMarkdown(originalURL) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // Reader URL is constructed from fixed, allowlisted upstream endpoints
    // rather than untrusted fields from the studio configuration.
    const endpoint = JINA_BASE + originalURL;
    const response = await fetch(endpoint, {
      method: 'GET', mode: 'cors', credentials: 'omit', signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Jina Reader returned HTTP ${response.status} for ${originalURL}`);
    const markdown = await response.text();
    const declaredURL = /^URL Source:\s*(\S+)\s*$/m.exec(markdown)?.[1];
    if (declaredURL && declaredURL !== originalURL) {
      throw new Error(`Unexpected Jina Reader source: ${declaredURL}`);
    }
    if (!markdown.includes('Markdown Content:')) {
      throw new Error(`Jina Reader supplied no Markdown content for ${originalURL}`);
    }
    return markdown;
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error(`Jina Reader timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${originalURL}`, { cause });
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}

function careersURL(studio) {
  const value = studio?.careers_url;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * For known CORS-blocked studios, return independently sourced public jobs.
 * Unknown/mismatched studios return null so the caller preserves its normal
 * error display. Kojima currently has no proven public GET listing feed; the
 * Crafty Apes public page lacks verifiable job links, so neither is guessed.
 */
export async function fetchAlternativeJobs(studio) {
  if (studio?.id === 'digitaldomain' && careersURL(studio) === DIGITAL_RSS) {
    const markdown = await fetchPublicMarkdown(DIGITAL_RSS);
    const jobs = parseDigitalDomainMarkdown(markdown);
    if (!jobs.length) throw new Error('Digital Domain RSS fallback contained no verifiable job links');
    return jobs;
  }
  if (studio?.id === 'wildbrain' && careersURL(studio) === WILDBRAIN_BOARD) {
    let primaryError;
    try {
      const markdown = await fetchPublicMarkdown(WILDBRAIN_BOARD);
      const jobs = parseWildBrainMarkdown(markdown);
      if (jobs.length) return jobs;
      primaryError = new Error('WildBrain landing page contained no verifiable job links');
    } catch (error) { primaryError = error; }
    try {
      const markdown = await fetchPublicMarkdown(WILDBRAIN_ALL);
      const jobs = parseWildBrainMarkdown(markdown);
      if (!jobs.length) throw new Error('WildBrain full listing contained no verifiable job links');
      return jobs;
    } catch (error) {
      throw new Error(`WildBrain public GET feeds failed: ${primaryError?.message}; ${error.message}`, {
        cause: error,
      });
    }
  }
  return null;
}
