// npm-friendly unit checks:
//   node --test web/test-alternative-feeds.mjs
// Optional independently fetched, original origin/main Python comparison:
//   node web/test-alternative-feeds.mjs --live
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDigitalDomainMarkdown, parseWildBrainMarkdown, fetchAlternativeJobs,
} from './alternative-feeds.js';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(webDir, '..');
const studios = Object.fromEntries(
  JSON.parse(readFileSync(path.join(webDir, 'data', 'studios.json'), 'utf8'))
    .map(studio => [studio.id, studio]),
);
const actualFetch = globalThis.fetch;

const DIGITAL_FIXTURE = `Title: Digital Domain : Studio all
URL Source: http://careers.digitaldomain.com/rss.php
Markdown Content:
### [Animation Supervisor : VC](http://careers.digitaldomain.com/application.php?job_id=25_2_1710)
Animation Supervisor [description](http://careers.digitaldomain.com/description/25_2_1710.pdf)
### [Animation Supervisor : PL](http://careers.digitaldomain.com/application.php?job_id=25_6_1709)
Animation Supervisor [description](http://careers.digitaldomain.com/description/25_6_1709.pdf)
### [Unverified opening : XX](https://evil.example/application.php?job_id=25_2_1711)
### [Invalid path : VC](https://careers.digitaldomain.com/application.php?job_id=bad)
`;
const WILDBRAIN_FIXTURE = `Title: WILDBRAIN STUDIOS - Job openings
URL Source: https://wildbrain-career.talent-soft.com/accueil.aspx?LCID=1033
Markdown Content:
* ### [Senior Talent Acquisition Partner](https://wildbrain-career.talent-soft.com/job/job-senior-talent-acquisition-partner_5727.aspx "Senior Talent Acquisition Partner")
*   Senior Talent Acquisition Partner : 2026-5727
*   Vancouver
* ### [Art Director, 2D](https://wildbrain-career.talent-soft.com/job/job-art-director-2d_5699.aspx "Art Director, 2D")
*   Art Director, 2D : 2026-5699
*   Design
* ### [Unrelated](https://evil.example/job/job-attacker_13.aspx)
`;

test('Digital Domain job, location and PDF extraction matches the real feed shape', () => {
  const jobs = parseDigitalDomainMarkdown(DIGITAL_FIXTURE);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(j => [j.title, j.location]), [
    ['Animation Supervisor', 'Vancouver, Canada'],
    ['Animation Supervisor', 'Playa Vista, United States'],
  ]);
  assert.equal(jobs[0].link, 'http://careers.digitaldomain.com/application.php?job_id=25_2_1710');
  assert.equal(jobs[0].extraLink, 'http://careers.digitaldomain.com/description/25_2_1710.pdf');
  assert.equal(jobs[0].proxied, true);
});

test('WildBrain job extraction retains original TalentSoft links with Vancouver fallback', () => {
  const jobs = parseWildBrainMarkdown(WILDBRAIN_FIXTURE);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(j => [j.title, j.location]), [
    ['Senior Talent Acquisition Partner', 'Vancouver'],
    ['Art Director, 2D', 'Vancouver'],
  ]);
  assert.equal(jobs[1].link, 'https://wildbrain-career.talent-soft.com/job/job-art-director-2d_5699.aspx');
  assert.equal(jobs[1].extraLink, '');
  assert.ok(jobs.every(j => j.source.includes('WildBrain') && j.proxied === true));
});

test('loader uses only fixed browser GET sources, with no credentials, headers or POST', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => url.includes('digitaldomain') ? DIGITAL_FIXTURE : WILDBRAIN_FIXTURE,
    };
  };
  try {
    const dd = await fetchAlternativeJobs(studios.digitaldomain);
    const wb = await fetchAlternativeJobs(studios.wildbrain);
    assert.equal(dd.length, 2);
    assert.equal(wb.length, 2);
    assert.deepEqual(calls.map(c => c.url), [
      'https://r.jina.ai/http://careers.digitaldomain.com/rss.php',
      'https://r.jina.ai/https://wildbrain-career.talent-soft.com/accueil.aspx?LCID=1033',
    ]);
    assert.ok(calls.every(c => c.options.method === 'GET' &&
      c.options.mode === 'cors' && c.options.credentials === 'omit' &&
      !c.options.headers && !c.options.body));
  } finally { globalThis.fetch = actualFetch; }
});

test('WildBrain switches to the full public GET listings if its homepage yields no jobs', async () => {
  const called = [];
  globalThis.fetch = async url => {
    called.push(url);
    return { ok: true, text: async () =>
      called.length === 1 ? 'Markdown Content:\nNo live jobs here' :
        WILDBRAIN_FIXTURE.replace(
          'https://wildbrain-career.talent-soft.com/accueil.aspx?LCID=1033',
          'https://wildbrain-career.talent-soft.com/job/list-of-all-jobs.aspx',
        ) };
  };
  try {
    assert.equal((await fetchAlternativeJobs(studios.wildbrain)).length, 2);
    assert.equal(called.length, 2);
    assert.equal(called[1], 'https://r.jina.ai/https://wildbrain-career.talent-soft.com/job/list-of-all-jobs.aspx');
  } finally { globalThis.fetch = actualFetch; }
});

test('unsupported studios and unexpectedly changed studio endpoints do not proxy', async () => {
  globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
  try {
    assert.equal(await fetchAlternativeJobs(studios.craftyapes), null);
    assert.equal(await fetchAlternativeJobs(studios.kojimaproductions), null);
    assert.equal(await fetchAlternativeJobs(studios.pixar), null);
    assert.equal(await fetchAlternativeJobs({ ...studios.digitaldomain, careers_url: 'https://evil.example/rss.php' }), null);
    assert.equal(await fetchAlternativeJobs({ ...studios.wildbrain, careers_url: 'https://evil.example/' }), null);
  } finally { globalThis.fetch = actualFetch; }
});

test('empty or unrelated returned data never generates fabricated vacancy records', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => 'URL Source: http://careers.digitaldomain.com/rss.php\nMarkdown Content:\nNo positions found',
  });
  try {
    await assert.rejects(fetchAlternativeJobs(studios.digitaldomain), /no verifiable job links/);
  } finally { globalThis.fetch = actualFetch; }
});

if (process.argv.includes('--live')) {
  test('live Jina responses match all Python origin/main title/link/location/extra links', { timeout: 95000 }, async () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'jobui-alternative-live-'));
    const python = process.env.PYTHON || [
      path.join(repoDir, '..', '..', '.venv', 'bin', 'python'),
      path.join(repoDir, '.venv', 'bin', 'python'),
      'python3',
    ].find(p => p === 'python3' || existsSync(p));
    try {
      const core = path.join(temp, 'core');
      mkdirSync(core);
      writeFileSync(path.join(core, '__init__.py'), '');
      for (const f of ['job_scraper.py', 'extractor.py', 'logger.py']) {
        const contents = execFileSync('git', ['show', `origin/main:core/${f}`], {
          cwd: repoDir, encoding: 'utf8',
        });
        writeFileSync(path.join(core, f), contents);
      }
      const originalConfig = JSON.parse(execFileSync('git', ['show', 'origin/main:config/studios.json'], {
        cwd: repoDir, encoding: 'utf8',
      }));
      const main = Object.fromEntries(originalConfig.map(x => [x.id, x]));
      const pyScript = `
import sys,json
sys.path.insert(0, sys.argv[1])
from core.job_scraper import JobScraper
jobs=JobScraper().fetch_jobs(json.load(sys.stdin))
print("PYTHON_RESULTS="+json.dumps([{
    "title": str(x.get("title") or ""),
    "link": str(x.get("link") or ""),
    "location": str(x.get("location") or ""),
    "extraLink": str(x.get("extra_link") or ""),
} for x in jobs]))
`;
      for (const studioId of ['digitaldomain', 'wildbrain']) {
        const expected = spawnSync(python, ['-c', pyScript, temp], {
          cwd: repoDir, input: JSON.stringify(main[studioId]), timeout: 28000,
          encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        });
        assert.equal(expected.status, 0,
          `${studioId}: original Python failed: ${expected.error || expected.stderr || expected.stdout}`);
        const marker = expected.stdout.split('\n').find(line => line.startsWith('PYTHON_RESULTS='));
        assert.ok(marker, `${studioId}: Python returned no comparison JSON`);
        const baseline = JSON.parse(marker.slice('PYTHON_RESULTS='.length));
        const alt = await fetchAlternativeJobs(main[studioId]);
        const comparable = entries => entries.map(row => [
          row.title, row.link, row.location, row.extraLink || '',
        ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        console.log(`Live ${studioId}: Python ${baseline.length}; public GET alternative ${alt.length}`);
        assert.deepEqual(comparable(alt), comparable(baseline),
          `${studioId}: actual postings differ; no passing-on-empty or approximations`);
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}
