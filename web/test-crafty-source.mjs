// Run: node --test web/test-crafty-source.mjs
// Optional exact live comparison against origin/main Python:
//      node --test web/test-crafty-source.mjs --live
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CRAFTY_BOARD_URL, CRAFTY_SEARCH_URL, CRAFTY_JINA_URL,
  parseCraftyMarkdown, fetchCraftyPublicJobs
} from './crafty-source.js';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(webDir);
const studio = JSON.parse(readFileSync(path.join(webDir, 'data/studios.json'), 'utf8'))
  .find(studio => studio.id === 'craftyapes');

// These 16 identifiers, names and locations were independently read from the
// live public board and compared to the current origin/main Python scraper.
const exactPythonBaseline = [
  [286, 'Compositor - LA', 'Los Angeles Office, 556 S. Fair Oaks Ave, Pasadena, California, United States of America'],
  [284, 'Character FX Artist - Australia I Montreal I Vancouver', 'Australia'],
  [282, 'VFX Bidding Producer- West Coast US or Australia', 'Australia'],
  [280, 'Senior Production Manager - Australia', 'Australia'],
  [278, 'Senior Digital Matte Painter', 'Australia'],
  [276, 'ML Compositor TD', 'Australia'],
  [274, 'Compositing Supervisor- Australia', 'Australia'],
  [270, 'Expression of Interest - 2D Compositors I New York and New Jersey', 'New York Office, 224 West 35th Street, New York, New York, United States of America'],
  [268, 'Compositor- London', 'United Kingdom'],
  [260, 'Mid - Senior Compositor - Australia', 'Australia'],
  [258, 'CG Supervisor - London', 'United Kingdom'],
  [256, 'Lighting Artist - London', 'United Kingdom'],
  [254, 'CG Artist ( Assets ) Mid/Senior - London', 'United Kingdom'],
  [248, 'Rigger Mid/Senior - London', 'United Kingdom'],
  [246, 'Crowd Mid -Senior - London', 'United Kingdom'],
  [238, 'General Expression Of Interest', 'Australia'],
];
const urlFor = id => CRAFTY_BOARD_URL + '/jobs/' + id;
const markdownRows = exactPythonBaseline.map(([id, title, location]) =>
  '*   ## [' + title + '](' + urlFor(id) + ')     ' + location +
  ' Posted Thursday, September 24, 2026 Real job description'
);
const fixture = [
  'Title: Job Board | Dayforce Jobs',
  'URL Source: ' + CRAFTY_BOARD_URL,
  'Markdown Content:',
  ...markdownRows,
].join('\n');
const actualFetch = globalThis.fetch;

function normalized(rows) {
  return rows.map(job => ({
    title: job.title, location: job.location, link: job.link, extraLink: job.extraLink || ''
  })).sort((a, b) => a.link.localeCompare(b.link));
}

function baseline() {
  return normalized(exactPythonBaseline.map(([id, title, location]) => ({
    title, location, link: urlFor(id), extraLink: ''
  })));
}

test('parses exactly all 16 independently verified public Dayforce jobs', () => {
  const jobs = parseCraftyMarkdown(fixture);
  assert.equal(jobs.length, 16);
  assert.deepEqual(normalized(jobs), baseline());
  assert.ok(jobs.every(job => job.proxied && job.source === 'Crafty Apes public Dayforce via Jina Reader'));
  assert.ok(jobs.every(job => job.link.startsWith(CRAFTY_BOARD_URL + '/jobs/')));
});

test('deduplicates repeated identical postings, but not distinct job identifiers', () => {
  const jobs = parseCraftyMarkdown(fixture + '\n' + markdownRows[0]);
  assert.equal(jobs.length, 16);
});

test('rejects missing title, missing verified posted date/location, and untrusted job links', () => {
  const malformed = [
    '*   ## [Untrusted](https://evil.example/en-US/craftyapes/CANDIDATEPORTAL/jobs/100) London Posted Thursday, September 24, 2026',
    '*   ## [Untrusted](javascript:alert(1)) London Posted Thursday, September 24, 2026',
    '*   ## [Untrusted](https://jobs.dayforcehcm.com/en-US/another/CANDIDATEPORTAL/jobs/100) London Posted Thursday, September 24, 2026',
    '*   ## [No location](' + urlFor(1234) + ') Posted Thursday, September 24, 2026',
    '*   ## [No date](' + urlFor(1235) + ') London work description only',
    '*   ## [](' + urlFor(1236) + ') London Posted Thursday, September 24, 2026',
    '*   ## [Bad ID](' + CRAFTY_BOARD_URL + '/jobs/0) London Posted Thursday, September 24, 2026',
    '*   ## [Bad ID](' + CRAFTY_BOARD_URL + '/jobs/hello) London Posted Thursday, September 24, 2026'
  ].join('\n');
  assert.deepEqual(parseCraftyMarkdown(malformed), []);
});

test('anonymous client uses only public Jina GET with explicit Markdown and no secrets', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(fixture, { status: 200 });
  };
  try {
    const jobs = await fetchCraftyPublicJobs(studio);
    assert.deepEqual(normalized(jobs), baseline());
    assert.equal(calls.length, 1);
    const { url, options } = calls[0];
    assert.equal(url, CRAFTY_JINA_URL);
    assert.equal(options.method, 'GET');
    assert.equal(options.mode, 'cors');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['X-Respond-With'], 'markdown');
    assert.equal(options.body, undefined);
    assert.ok(options.signal);
  } finally { globalThis.fetch = actualFetch; }
});

test('strict studio and source gates do not trigger network for unrelated/changed config', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected request'); };
  try {
    const invalid = [
      { ...studio, id: 'not-craftyapes' },
      { ...studio, website: 'https://other.example' },
      { ...studio, careers_url: 'https://evil.example/jobposting/search' },
      { ...studio, scraping: { ...studio.scraping, method: 'GET' } },
      { ...studio, scraping: { ...studio.scraping, map: { ...studio.scraping.map,
        link: { path: 'jobPostingId', prefix: 'https://evil.example/jobs/' } } } }
    ];
    for (const candidate of invalid) {
      assert.equal(await fetchCraftyPublicJobs(candidate), null);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = actualFetch; }
});

test('HTTP errors, source mismatches and unlinked content never masquerade as empty success', async () => {
  const cases = [
    [new Response('Denied', { status: 403 }), /HTTP 403/],
    [new Response(fixture.replace(CRAFTY_BOARD_URL, 'https://evil.example')), /verified Dayforce board/],
    [new Response('URL Source: ' + CRAFTY_BOARD_URL + '\nMarkdown Content:\nNo live job links'), /no verifiable linked jobs/],
    [new Response(fixture.replace('Markdown Content:', 'Unrelated:')), /verified Dayforce board/],
    [new Response(fixture.replace('Markdown Content:', 'Warning: Target URL returned error 404\nMarkdown Content:')), /verified Dayforce board/]
  ];
  try {
    for (const [response, pattern] of cases) {
      globalThis.fetch = async () => response;
      await assert.rejects(fetchCraftyPublicJobs(studio), pattern);
    }
  } finally { globalThis.fetch = actualFetch; }
});

if (process.argv.includes('--live')) {
  test('live Jina anonymous GET matches current origin/main Python exactly, including links and locations',
    { timeout: 90_000 }, async () => {
      const temp = mkdtempSync(path.join(tmpdir(), 'jobui-crafty-live-'));
      const py = process.env.PYTHON || [
        path.resolve(repoDir, '../../.venv/bin/python'),
        path.join(repoDir, '.venv/bin/python'),
        'python3',
      ].find(item => item === 'python3' || existsSync(item));
      try {
        const core = path.join(temp, 'core');
        mkdirSync(core);
        writeFileSync(path.join(core, '__init__.py'), '');
        for (const name of ['job_scraper.py', 'extractor.py', 'logger.py']) {
          writeFileSync(path.join(core, name), execFileSync('git',
            ['show', 'origin/main:core/' + name], { cwd: repoDir, encoding: 'utf8' }));
        }
        const main = JSON.parse(execFileSync('git',
          ['show', 'origin/main:config/studios.json'], { cwd: repoDir, encoding: 'utf8' }))
          .find(item => item.id === 'craftyapes');
        const script = [
          'import sys,json',
          'sys.path.insert(0, sys.argv[1])',
          'from core.job_scraper import JobScraper',
          'jobs=JobScraper().fetch_jobs(json.load(sys.stdin))',
          'print("BASELINE="+json.dumps([{"title": j.get("title",""),"location": j.get("location",""),',
          '"link": j.get("link",""),"extraLink": j.get("extra_link","")} for j in jobs]))',
        ].join('\n');
        const result = spawnSync(py, ['-c', script, temp], {
          cwd: repoDir, input: JSON.stringify(main), encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
        });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        const marker = result.stdout.split('\n').find(line => line.startsWith('BASELINE='));
        assert.ok(marker, 'Python did not return comparison JSON');
        const baselineJobs = JSON.parse(marker.slice('BASELINE='.length));
        assert.equal(baselineJobs.length, 16, 'baseline changed since earlier verified inspection');
        const live = await fetchCraftyPublicJobs(studio);
        console.log('Crafty Apes live Python', baselineJobs.length, 'browser GET', live.length);
        assert.deepEqual(normalized(live), normalized(baselineJobs));
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
}
