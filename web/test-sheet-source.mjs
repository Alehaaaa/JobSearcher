import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCSV, parseSheetReference, parsePublicSheetCSV, fetchPublicSheet,
  PUBLIC_SHEET_URL, PUBLIC_SHEET_CSV_URL,
} from './sheet-source.js';

const headings = ['Studio\n(Featured)', '', 'City', '', 'Province', '', 'Country', '',
  'Job Title', '', 'Experience Level', '', 'Remote/Hybrid', '', 'Date', '', 'Source/Contact'];
const csvField = value => '"' + String(value).replaceAll('"', '""') + '"';
const record = fields => fields.map(csvField).join(',');

test('CSV parsing handles quoted commas, multiline headings and escaped quotes', () => {
  const sample = record(headings) + '\r\n' +
    record(['A "Studio"', '', 'New York', '', 'New York', '', 'United States', '',
      'Compositor, Senior', '', 'Senior', '', 'Remote', '', 'October 12, 2026', '',
      'https://example.com/job/1']);
  const rows = parseCSV(sample);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0], 'Studio\n(Featured)');
  assert.equal(rows[1][0], 'A "Studio"');
  assert.equal(rows[1][8], 'Compositor, Senior');
});

test('Public sheet accepts actual source links and email application contacts', () => {
  const sample = record(headings) + '\n' +
    record(['Test Studio', '', 'Barcelona', '', 'Catalunya', '', 'Spain', '', 'Artist', '',
      'Associate', '', 'Remote', '', 'October 12, 2026', '', 'jobs@teststudio.example']) + '\n' +
    record(['Test Studio', '', 'Barcelona', '', 'Catalunya', '', 'Spain', '', 'Artist', '',
      'Associate', '', 'Remote', '', 'October 12, 2026', '', 'jobs@teststudio.example']) + '\n' +
    record(['Another Studio', '', 'London', '', '', '', 'UK', '', 'Animator', '',
      'Internship', '', 'Hybrid', '', 'October 13, 2026', '',
      'https://example.com/apply/2']) + '\n' +
    record(['Invalid Studio', '', '', '', '', '', '', '', 'Fake Job', '', '', '', '', '',
      'October 1, 2026', '', 'javascript:alert(1)']);
  const jobs = parsePublicSheetCSV(sample);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].title, 'Animator');
  assert.equal(jobs[1].link, 'mailto:jobs@teststudio.example');
  assert.equal(jobs[1].location, 'Remote · Barcelona, Catalunya, Spain');
  assert.equal(jobs[1].experienceLevel, 'Associate');
});

test('Public sheet schema mismatch rejects rather than guessing columns', () => {
  assert.throws(() => parsePublicSheetCSV('Studio,Job Title,Notes\nCompany,Artist,http://a.test'), /columns have changed/);
});

const SAMPLE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890';
const view = 'https://docs.google.com/spreadsheets/d/' + SAMPLE_ID;
const csvAt = gid => view + '/gviz/tq?tqx=out:csv&gid=' + gid;

test('Google Sheets edit, hash-gid, GViz CSV, export and bare-ID normalize to one anonymous feed', () => {
  const cases = [
    view + '/edit?gid=987654321#gid=0',
    view + '/edit#gid=987654321',
    view + '/gviz/tq?gid=987654321&tqx=out:csv',
    view + '/export?format=csv&gid=987654321',
    view + '/pubhtml?gid=987654321',
  ];
  for (const input of cases) {
    const ref = parseSheetReference(input);
    assert.equal(ref.id, SAMPLE_ID);
    assert.equal(ref.gid, '987654321');
    assert.equal(ref.key, SAMPLE_ID + ':987654321');
    assert.equal(ref.csvUrl, csvAt('987654321'));
    assert.equal(ref.url, view + '/edit?gid=987654321');
  }
  assert.equal(parseSheetReference(SAMPLE_ID).csvUrl, csvAt('0'));
  assert.equal(parseSheetReference(PUBLIC_SHEET_URL).csvUrl, PUBLIC_SHEET_CSV_URL);
  assert.deepEqual(parseSheetReference(parseSheetReference(view + '/edit?gid=123')),
    parseSheetReference(view + '/edit?gid=123'));
});

test('multiple tabs and named local list metadata have independent stable keys', () => {
  const first = parseSheetReference({ url: view + '/edit?gid=3', name: 'Animation Jobs' });
  const second = parseSheetReference({ url: view + '/edit?gid=4', name: 'Games Opportunities' });
  const namedTab = parseSheetReference({ url: view + '/gviz/tq?tqx=out:csv&sheet=Artists', name: 'Artists' });
  assert.equal(first.key, SAMPLE_ID + ':3');
  assert.equal(second.key, SAMPLE_ID + ':4');
  assert.notEqual(first.key, second.key);
  assert.equal(namedTab.csvUrl, view + '/gviz/tq?tqx=out:csv&sheet=Artists');
  assert.equal(namedTab.key, SAMPLE_ID + ':sheet:Artists');
  assert.equal(first.name, 'Animation Jobs');
  assert.equal(second.name, 'Games Opportunities');
});

test('invalid schemes, lookalike domains, untrusted endpoints and bad gids are rejected', () => {
  const attempts = [
    'javascript:alert(1)', 'http://docs.google.com/spreadsheets/d/' + SAMPLE_ID + '/edit',
    'https://docs.google.com.evil.example/spreadsheets/d/' + SAMPLE_ID + '/edit',
    'https://user:password@docs.google.com/spreadsheets/d/' + SAMPLE_ID + '/edit',
    'https://evil.example/' + SAMPLE_ID, 'https://docs.google.com/spreadsheets/d/e/2PACX-EXAMPLE/pubhtml',
    view + '/edit?gid=abc', view + '/edit?gid=-1',
    view + '/gviz/tq?gid=0&tqx=out:json',
    view + '/gviz/tq?tqx=out:csv&tq=select%20A',
    view + '/export?format=xlsx&gid=0',
  ];
  for (const item of attempts) {
    assert.throws(() => parseSheetReference(item), Error, item);
  }
  assert.throws(() => parseSheetReference({ url: view, name: 'x'.repeat(101) }), /name/);
  assert.throws(() => parseSheetReference({ url: view, sheet: 'Bad\nTab' }), /tab name/);
});

test('flat community CSV headers, repeated locations, unsafe links and optional names', () => {
  const records = [
    'Company,Role,Application URL,Location,Seniority,Work Mode,Posted On',
    'Art Works,Mid Animator,https://jobs.example.com/apply/1,Barcelona,Mid,Hybrid,2026-10-12',
    'Art Works,Mid Animator,https://jobs.example.com/apply/1,Barcelona,Mid,Hybrid,2026-10-12',
    'Studio 2,FX Artist,javascript:alert(1),London,Senior,Remote,2026-10-13',
    'Studio 3,FX TD,mailto:careers@example.com,New York,Junior,Remote,2026-10-11',
  ].join('\n');
  const ref = parseSheetReference({ url: view + '/edit?gid=7', name: 'Community Favorites' });
  const result = parsePublicSheetCSV(records, ref);
  assert.equal(result.length, 2);
  assert.equal(result[0].studioName, 'Art Works');
  assert.equal(result[0].location, 'Barcelona');
  assert.equal(result[1].location, 'Remote · New York');
  assert.equal(result[1].link, 'mailto:careers@example.com');
  assert.ok(result.every(row => row.sheetGid === '7' && row.listName === 'Community Favorites'));
  assert.ok(result.every(row => row.sheetId === SAMPLE_ID && row.sheetUrl === ref.url));
});

test('unquoted illegal quotes, dangling CSV quote and control-character job links are rejected', () => {
  assert.throws(() => parseCSV('Company,Role,Link\nFake,"Broken\n'), /quoted field/);
  assert.throws(() => parseCSV('Company,Role,Link\nFa"ke,Role,Link'), /quoting/);
  assert.equal(parsePublicSheetCSV('Company,Role,Link\nA,Animator,javascript:alert(1)\n').length, 0);
  assert.equal(parsePublicSheetCSV('Company,Role,Link\nA,Animator,https://user:pass@example.com/role').length, 0);
});

test('Anonymous CSV fetch uses no credentials, no API key, and parses rows', async () => {
  const original = globalThis.fetch;
  let request;
  try {
    globalThis.fetch = async (url, init) => {
      request = { url, init };
      return new Response(record(headings) + '\n' +
        record(['A', '', 'Paris', '', '', '', 'France', '', 'FX Artist', '', 'Mid', '',
          'Hybrid', '', 'October 12, 2026', '', 'https://example.com/artist']),
      { status: 200, headers: { 'content-type': 'text/csv' } });
    };
    assert.equal((await fetchPublicSheet()).length, 1);
    assert.equal(request.url, PUBLIC_SHEET_CSV_URL);
    assert.equal(request.init.credentials, 'omit');
    assert.equal(request.init.mode, 'cors');
  } finally { globalThis.fetch = original; }
});

test('independent saved sheets fetch their own tabs and retain per-list attribution', async () => {
  const original = globalThis.fetch;
  const requests = [];
  const refs = [
    parseSheetReference({ url: view + '/edit?gid=101', name: 'Games' }),
    parseSheetReference({ url: view + '/edit?gid=202', name: 'Animation' }),
  ];
  try {
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      const role = url.includes('gid=101') ? 'Gameplay Programmer' : 'Character Animator';
      return new Response(
        'Studio,Job Title,Source/Contact,Country,Experience Level,Date\n' +
        'Different Studio,' + role + ',https://example.org/' + encodeURIComponent(role) + ',Spain,Senior,2026-10-13',
        { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } },
      );
    };
    const [a, b] = await Promise.all(refs.map(ref => fetchPublicSheet(ref)));
    assert.equal(a[0].title, 'Gameplay Programmer');
    assert.equal(b[0].title, 'Character Animator');
    assert.equal(a[0].listName, 'Games');
    assert.equal(b[0].listName, 'Animation');
    assert.equal(a[0].sheetGid, '101');
    assert.equal(b[0].sheetGid, '202');
    assert.deepEqual(requests.map(request => request.url), refs.map(ref => ref.csvUrl));
    assert.ok(requests.every(({ init }) => init.credentials === 'omit' &&
      init.mode === 'cors' && init.redirect === 'error' && !init.body && !init.headers));
  } finally { globalThis.fetch = original; }
});

test('explicit cancellation stops an in-flight request and is not mistaken for a timeout', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let called = 0;
  try {
    globalThis.fetch = (_url, init) => {
      called++;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort',
          () => reject(new DOMException('The request was aborted', 'AbortError')), { once: true });
      });
    };
    const request = fetchPublicSheet(PUBLIC_SHEET_URL, { signal: controller.signal, timeoutMs: 500 });
    controller.abort();
    await assert.rejects(request, error => error?.name === 'AbortError' && /cancelled/.test(error.message));
    await assert.rejects(fetchPublicSheet(PUBLIC_SHEET_URL, { signal: controller.signal }), /cancelled/);
    assert.equal(called, 1, 'Pre-cancelled fetch should not reach the network');
  } finally { globalThis.fetch = original; }
});

test('a timed out public fetch reports a deadline error rather than generic CORS failure', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort',
        () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    await assert.rejects(fetchPublicSheet(PUBLIC_SHEET_URL, { timeoutMs: 5 }), /timed out after 5 ms/);
    await assert.rejects(fetchPublicSheet(PUBLIC_SHEET_URL, { timeoutMs: 0 }), /timeout must be/);
  } finally { globalThis.fetch = original; }
});

test('private, login HTML and oversized Sheets responses fail explicitly', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('Not accessible', { status: 403 });
    await assert.rejects(fetchPublicSheet(), /HTTP 403.*publicly readable/);
    globalThis.fetch = async () => new Response('<html><body>Sign in to Google</body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
    await assert.rejects(fetchPublicSheet(), /non-CSV page/);
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new Uint8Array(2_500_000));
        ctrl.enqueue(new Uint8Array(2_000_001));
        ctrl.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/csv' } });
    await assert.rejects(fetchPublicSheet(), /exceeds 4 MB/);
  } finally { globalThis.fetch = original; }
});

test('transport/CORS errors are identified without asserting which layer blocked access', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(fetchPublicSheet(PUBLIC_SHEET_URL), /network\/CORS or inaccessible sheet/);
  } finally { globalThis.fetch = original; }
});

if (process.argv.includes('--live')) {
  test('live anonymous Google Sheet returns real attributed listings', async () => {
    const jobs = await fetchPublicSheet();
    assert.ok(jobs.length > 100, 'Expected a populated public community listings spreadsheet');
    assert.ok(jobs.every(job => job.studioName && job.title && /^https?:|^mailto:/.test(job.link)));
    assert.ok(jobs.some(job => job.experienceLevel), 'Expected genuine experience-level metadata');
    console.log('Live anonymous spreadsheet records:', jobs.length);
  });
}

test('blank Boolean cells from Google Sheets do not become city, province or country', () => {
  const sample = record(headings) + '\n' +
    record(['Unknown Studio', '', 'Sarajevo', '', 'FALSE', '', 'Bosnia and Herzegovina', '',
      'Level Designer', '', 'Senior', '', 'Hybrid', '', 'October 12, 2026', '',
      'https://example.org/job/1']) + '\n' +
    record(['Another Studio', '', 'Almaty', '', 'FALSE', '', 'Kazakhstan', '',
      'Artist', '', 'Mid', '', 'Hybrid', '', 'October 12, 2026', '',
      'https://example.org/job/2']) + '\n' +
    'Studio,Job Title,Source/Contact,Location\n';
  const jobs = parsePublicSheetCSV(sample);
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find(job => job.studioName === 'Unknown Studio').location,
    'Sarajevo, Bosnia and Herzegovina');
  assert.equal(jobs.find(job => job.studioName === 'Another Studio').location,
    'Almaty, Kazakhstan');
  const flat = parsePublicSheetCSV('Company,Role,Application URL,Location\n' +
    'Test Company,Animator,https://example.org/job/3,"Tallinn, FALSE, Estonia"');
  assert.equal(flat[0].location, 'Tallinn, Estonia');
});

test('renames the bundled default sheet but preserves custom saved names and other lists', async () => {
  const { displaySheetListName, DEFAULT_PUBLIC_SHEET_NAME } = await import('./sheet-source.js');
  const original = parseSheetReference(PUBLIC_SHEET_URL);
  assert.equal(DEFAULT_PUBLIC_SHEET_NAME, 'Animation/VFX/Game Jobs');
  assert.equal(displaySheetListName({ name: 'Community Jobs' }, original), DEFAULT_PUBLIC_SHEET_NAME);
  assert.equal(displaySheetListName({ name: 'Community Jobs Sheet' }, original), DEFAULT_PUBLIC_SHEET_NAME);
  assert.equal(displaySheetListName({ name: 'My own renamed list' }, original), 'My own renamed list');
  assert.equal(displaySheetListName({ name: 'Community Jobs' },
    parseSheetReference(view + '/edit?gid=0')), 'Community Jobs');
  assert.equal(original.csvUrl, PUBLIC_SHEET_CSV_URL);
});
