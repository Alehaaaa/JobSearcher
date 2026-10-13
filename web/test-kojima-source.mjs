// node --test web/test-kojima-source.mjs
// node web/test-kojima-source.mjs --live
//
// The --live check requires the original Python scraper's requests/bs4 venv,
// independently fetches original main's 35 jobs, validates every official
// page's published HRMOS application link against the 38 public GET jobs, and
// fails on any unmatched posting rather than pretending 38 === 35.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  KOJIMA_BOARD_URL,
  parseKojimaHRMOSHTML,
  parseKojimaJinaMarkdown,
  fetchKojimaJobs,
} from './kojima-source.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(moduleDir, '..');
const studio = JSON.parse(readFileSync(path.join(moduleDir, 'data', 'studios.json'), 'utf8'))
  .find(({ id }) => id === 'kojimaproductions');
const savedFetch = globalThis.fetch;
const dom = new JSDOM('');
globalThis.DOMParser = dom.window.DOMParser;

const fixture = `<!doctype html><html><body>
<ul>
 <li class="pg-list-cassette">
  <a href="https://hrmos.co/pages/2052996596448374784/jobs/0000015">
   <h2>アニメーター / Animator</h2>
   <span class="pg-list-cassette-body">
     English : https://hrmos.co/pages/2052996596448374784/jobs/0000015E
   </span>
   <ul class="sg-tags"><li class="sg-tag-location">東京都港区港南1-2-70 品川シーズンテラス</li></ul>
  </a>
 </li>
 <li class="pg-list-cassette">
  <a href="https://hrmos.co/pages/2052996596448374784/jobs/0000029">
   <h2>通訳・翻訳・コミュニケーション促進担当 【日・英】</h2>
   <span class="pg-list-cassette-body">
     English : https://hrmos.co/pages/2052996596448374784/jobs/0000029E
   </span>
   <ul class="sg-tags"><li class="sg-tag-location">東京都港区港南1-2-70 品川シーズンテラス</li></ul>
  </a>
 </li>
 <li class="pg-list-cassette">
  <a href="https://evil.example/pages/2052996596448374784/jobs/0000007">
   <h2>Injected source</h2>
  </a>
 </li>
 <li class="pg-list-cassette">
  <a href="javascript:alert('fake')"><h2>Fake</h2></a>
 </li>
</ul>
</body></html>`;

const jinaFixture = `Title: 株式会社コジマプロダクション

URL Source: ${KOJIMA_BOARD_URL}

Markdown Content:
## 全 2 件中 2 件 を表示しています
*   ## [アニメーター / Animator English: https://hrmos.co/pages/2052996596448374784/jobs/0000015E 仕事内容 [Houdini examples]](https://hrmos.co/pages/2052996596448374784/jobs/0000015)
*   ## [通訳・翻訳・コミュニケーション促進担当 【日・英】 English : https://hrmos.co/pages/2052996596448374784/jobs/0000029E 仕事内容 実務。](https://hrmos.co/pages/2052996596448374784/jobs/0000029)
*   ## [Malicious](https://evil.example/pages/2052996596448374784/jobs/0000015)
`;

test('HRMOS original HTML yields genuine English titles, source links and card-specific Tokyo locations', () => {
  const jobs = parseKojimaHRMOSHTML(fixture);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(({ title, location }) => [title, location]), [
    ['Animator', 'Tokyo, Japan'],
    ['通訳・翻訳・コミュニケーション促進担当 【日・英】', 'Tokyo, Japan'],
  ]);
  assert.equal(jobs[0].link, 'https://hrmos.co/pages/2052996596448374784/jobs/0000015E');
  assert.equal(jobs[0].extraLink, '');
  assert.equal(jobs[0].proxied, true);
  assert.match(jobs[0].source, /HRMOS public GET/);
});

test('a new job with a different or absent location is not incorrectly assigned Tokyo', () => {
  const html = fixture
    .replace('東京都港区港南1-2-70 品川シーズンテラス', 'London, United Kingdom')
    .replace('東京都港区港南1-2-70 品川シーズンテラス', '');
  const jobs = parseKojimaHRMOSHTML(html);
  assert.deepEqual(jobs.map(j => j.location), ['London, United Kingdom', '']);
});

test('Jina Markdown fallback uses only the explicitly published English links and leaves unknown location blank', () => {
  const jobs = parseKojimaJinaMarkdown(jinaFixture);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(j => [j.title, j.location]), [
    ['Animator', ''],
    ['通訳・翻訳・コミュニケーション促進担当 【日・英】', ''],
  ]);
  assert.equal(jobs[1].link, 'https://hrmos.co/pages/2052996596448374784/jobs/0000029E');
  assert.ok(jobs.every(j => j.proxied));
  assert.ok(jobs.every(j => j.source.includes('location unavailable')));
});

test('no crawling for unrelated studios or mutated Kojima primary endpoint', async () => {
  globalThis.fetch = async () => { throw new Error('No GET should occur'); };
  try {
    assert.equal(await fetchKojimaJobs({ ...studio, id: 'nintendo' }), null);
    assert.equal(await fetchKojimaJobs({ ...studio, careers_url: 'https://evil.example/load' }), null);
  } finally { globalThis.fetch = savedFetch; }
});

test('loader performs exactly a credential-free public GET through cors.dev and preserves source', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => fixture };
  };
  try {
    const jobs = await fetchKojimaJobs(studio);
    assert.equal(jobs.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://proxy.cors.dev/' + KOJIMA_BOARD_URL);
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.mode, 'cors');
    assert.equal(calls[0].options.credentials, 'omit');
    assert.ok(!calls[0].options.headers && !calls[0].options.body);
  } finally { globalThis.fetch = savedFetch; }
});

test('on HTTP or parser failure, falls back to public Jina HTML-safe Markdown source', async () => {
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    return calls.length === 1
      ? { ok: false, status: 503 }
      : { ok: true, status: 200, text: async () => jinaFixture };
  };
  try {
    const jobs = await fetchKojimaJobs(studio);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].location, '');
    assert.equal(calls[1], 'https://r.jina.ai/' + KOJIMA_BOARD_URL);
  } finally { globalThis.fetch = savedFetch; }
});

test('an unreachable primary and forged Jina source fails transparently', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? { ok: false, status: 405 }
      : { ok: true, text: async () => jinaFixture.replace(
        KOJIMA_BOARD_URL, 'https://attacker.example/jobs',
      ) };
  };
  try {
    await assert.rejects(fetchKojimaJobs(studio), /source URL did not match/);
  } finally { globalThis.fetch = savedFetch; }
});

// Run with --live when original Python's network dependencies are available.
if (process.argv.includes('--live')) {
  test('LIVE: 35/35 original Python official careers links correspond to active HRMOS jobs', {
    timeout: 110000,
  }, async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'kojima-live-parity-'));
    const python = process.env.PYTHON || [
      path.resolve(rootDir, '..', '..', '.venv', 'bin', 'python'),
      path.resolve(rootDir, '.venv', 'bin', 'python'),
      'python3',
    ].find(candidate => candidate === 'python3' || existsSync(candidate));
    try {
      mkdirSync(path.join(tmp, 'core'));
      writeFileSync(path.join(tmp, 'core', '__init__.py'), '');
      for (const name of ['job_scraper.py', 'extractor.py', 'logger.py']) {
        const contents = execFileSync('git', ['show', `origin/main:core/${name}`], {
          cwd: rootDir, encoding: 'utf8',
        });
        writeFileSync(path.join(tmp, 'core', name), contents);
      }
      const mainStudio = JSON.parse(execFileSync('git', ['show', 'origin/main:config/studios.json'], {
        cwd: rootDir, encoding: 'utf8',
      })).find(item => item.id === 'kojimaproductions');
      const pyCode = `
import sys,json,re,requests,concurrent.futures,bs4
sys.path.insert(0,sys.argv[1])
from core.job_scraper import JobScraper
s=json.load(sys.stdin)
jobs=JobScraper().fetch_jobs(s)
pattern=re.compile(r'https://hrmos\\.co/pages/2052996596448374784/jobs/[A-Za-z0-9]+/apply$')
def get(job):
    r=requests.get(job['link'],timeout=(5,12))
    r.raise_for_status()
    soup=bs4.BeautifulSoup(r.text,'html.parser')
    urls=[a['href'].removesuffix('/apply') for a in soup.select('a[href]') if pattern.fullmatch(a['href'])]
    return {'title':job['title'],'officialLink':job['link'],'hrmosLink':urls[0] if urls else None}
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    found=list(ex.map(get,jobs))
print('PARITY_JSON='+json.dumps({'pythonCount':len(jobs),'jobs':found}))
`;
      const py = spawnSync(python, ['-c', pyCode, tmp], {
        cwd: rootDir,
        encoding: 'utf8',
        input: JSON.stringify(mainStudio),
        timeout: 75000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        maxBuffer: 5 * 1024 * 1024,
      });
      assert.equal(py.status, 0, `Python live audit failed: ${py.error || py.stderr || py.stdout}`);
      const record = py.stdout.split('\n').find(line => line.startsWith('PARITY_JSON='));
      assert.ok(record, `Python produced no audit result: ${py.stdout}`);
      const baseline = JSON.parse(record.slice('PARITY_JSON='.length));
      const jobs = await fetchKojimaJobs(mainStudio);
      assert.ok(Array.isArray(jobs) && jobs.length,
        'Kojima live GET did not recover any verified positions');
      const fetched = new Set(jobs.map(job => job.link));
      const missing = baseline.jobs.filter(job => !job.hrmosLink || !fetched.has(job.hrmosLink));
      console.log(`Kojima original Python: ${baseline.pythonCount}; independent HRMOS GET: ${jobs.length}; overlapping verified official application links: ${baseline.jobs.length - missing.length}`);
      console.log('HRMOS-only additional genuine positions:', jobs.filter(j => !baseline.jobs.some(p => p.hrmosLink === j.link)).map(j => j.title));
      assert.equal(baseline.pythonCount, baseline.jobs.length);
      assert.equal(missing.length, 0, `Official jobs absent from public HRMOS: ${JSON.stringify(missing)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
