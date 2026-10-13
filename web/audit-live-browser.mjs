/**
 * Runs exactly one current web scraper against live studio endpoints, with
 * jsdom providing the browser DOMParser and CSS selector surface under Node.
 * This validates scraper extraction logic, but Node's fetch does NOT enforce
 * cross-origin browser CORS policies. It must not be reported as CORS success.
 */
import { JSDOM } from 'jsdom';
import { fetchJobs } from './scraper.js';

let payload = '';
for await (const chunk of process.stdin) payload += chunk;

try {
  const studio = JSON.parse(payload);
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://alehaaaa.github.io/JobSearcher/',
  });
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.location = dom.window.location;
  const jobs = await fetchJobs(studio);
  const warnings = (jobs.errors ?? []).map(error => ({
    code: error.code ?? 'UNKNOWN',
    message: error.message ?? String(error),
  }));
  console.log('AUDIT_JSON:' + JSON.stringify({
    ok: true,
    jobs: jobs.map(({ title, link, location, extraLink }) => ({
      title: title || '', link: link || '', location: location || '',
      extraLink: extraLink || '',
    })),
    warnings,
  }));
  dom.window.close();
} catch (error) {
  console.log('AUDIT_JSON:' + JSON.stringify({
    ok: false,
    error: String(error?.message ?? error),
    code: error?.code ?? '',
    warnings: (error?.errors ?? []).map(item => ({
      code: item.code ?? '',
      message: String(item.message ?? item),
    })),
  }));
  process.exitCode = 1;
}
