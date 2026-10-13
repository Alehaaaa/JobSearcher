/**
 * Public, browser-fetchable Crafty Apes Dayforce listings.
 *
 * The configured Dayforce search API is POST-only and its CSRF cookie is
 * HttpOnly. Do not attempt to bypass authentication or read that cookie.
 * Instead, Jina Reader renders the public job board into Markdown containing
 * real Dayforce job-detail links. It supports anonymous GET, with CORS
 * preflight for the X-Respond-With: markdown request header.
 *
 * This module is intentionally not wired into scraper.js: the integrating
 * caller may invoke it only as a fallback after the normal source fails.
 */
export const CRAFTY_BOARD_URL =
  'https://jobs.dayforcehcm.com/en-US/craftyapes/CANDIDATEPORTAL';
export const CRAFTY_SEARCH_URL =
  'https://jobs.dayforcehcm.com/api/geo/craftyapes/jobposting/search';
export const CRAFTY_JINA_URL = 'https://r.jina.ai/' + CRAFTY_BOARD_URL;

const JOB_URL_PREFIX = CRAFTY_BOARD_URL + '/jobs/';
const MAX_MARKDOWN_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 20_000;
const SOURCE = 'Crafty Apes public Dayforce via Jina Reader';
const POSTED_DATE = /\s+Posted\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\b/;
const HEADING = /^\s*\*[ \t]*##[ \t]*\[([^\]\r\n]+)\]\((https:\/\/jobs\.dayforcehcm\.com\/en-US\/craftyapes\/CANDIDATEPORTAL\/jobs\/([0-9]+))\)[ \t]+([^\r\n]*)$/gm;

function clean(value) {
  return String(value ?? '').replace(/\\(.)/g, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * Parse only actual Markdown job headings, not arbitrary text or guesses from
 * vacancy descriptions. No entry is returned without title, job ID and
 * location explicitly present in the published listings.
 */
export function parseCraftyMarkdown(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('Expected public Dayforce Markdown');
  const jobs = [];
  const seen = new Set();
  for (const match of markdown.matchAll(HEADING)) {
    const title = clean(match[1]);
    const link = match[2];
    const locationAndDescription = match[4];
    const postedDate = POSTED_DATE.exec(locationAndDescription);
    if (!title || !postedDate) continue;
    const location = clean(locationAndDescription.slice(0, postedDate.index));
    if (!location) continue;
    let url;
    try { url = new URL(link); } catch { continue; }
    if (url.origin !== 'https://jobs.dayforcehcm.com' ||
        !url.href.startsWith(JOB_URL_PREFIX) ||
        url.pathname !== '/en-US/craftyapes/CANDIDATEPORTAL/jobs/' + match[3] ||
        !/^[1-9][0-9]*$/.test(match[3])) continue;
    const key = title.toLowerCase() + '|' + url.href.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({
      title, location, link: url.href, extraLink: '', source: SOURCE, proxied: true
    });
  }
  return jobs;
}

function supportedCraftyStudio(studio) {
  return studio?.id === 'craftyapes' &&
    studio.careers_url === CRAFTY_SEARCH_URL &&
    studio.website === CRAFTY_BOARD_URL &&
    studio.scraping?.strategy === 'json' &&
    String(studio.scraping.method).toUpperCase() === 'POST' &&
    studio.scraping.path === 'jobPostings[*]' &&
    studio.scraping.map?.title === 'jobTitle' &&
    studio.scraping.map?.link?.path === 'jobPostingId' &&
    studio.scraping.map.link.prefix === JOB_URL_PREFIX &&
    studio.scraping.map?.location === 'postingLocations[0].formattedAddress';
}

/**
 * Fetch independently from a public, allowlisted GET listing endpoint.
 *
 * Unsupported/mismatched configurations return null without any request.
 * The caller decides whether to invoke this after a Dayforce source failure.
 * Errors are never disguised as a successful empty vacancy list.
 *
 * @returns {Promise<null|Array<{title:string,location:string,link:string,extraLink:string,source:string,proxied:boolean}>>}
 */
export async function fetchCraftyPublicJobs(studio) {
  if (!supportedCraftyStudio(studio)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(CRAFTY_JINA_URL, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'X-Respond-With': 'markdown' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Crafty public Jina GET returned HTTP ' + response.status);
    const markdown = await response.text();
    if (new TextEncoder().encode(markdown).length > MAX_MARKDOWN_BYTES) {
      throw new Error('Crafty public Jina GET exceeded the 1 MiB response limit');
    }
    const declaredURL = /^URL Source:[ \t]*(\S+)[ \t]*$/m.exec(markdown)?.[1];
    if (declaredURL !== CRAFTY_BOARD_URL ||
        !/^Markdown Content:[ \t]*$/m.test(markdown) ||
        /^Warning:\s*Target URL returned error/m.test(markdown)) {
      throw new Error('Crafty public Jina GET did not return the verified Dayforce board');
    }
    const jobs = parseCraftyMarkdown(markdown);
    if (!jobs.length) throw new Error('Crafty public Dayforce board had no verifiable linked jobs');
    return jobs;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Crafty public Jina GET exceeded 20 seconds', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
