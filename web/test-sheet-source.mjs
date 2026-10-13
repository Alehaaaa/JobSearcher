import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCSV, parsePublicSheetCSV, fetchPublicSheet, PUBLIC_SHEET_CSV_URL } from './sheet-source.js';

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
  assert.throws(() => parsePublicSheetCSV('Studio,Job Title,Source\nCompany,Artist,http://a.test'), /columns have changed/);
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

if (process.argv.includes('--live')) {
  test('live anonymous Google Sheet returns real attributed listings', async () => {
    const jobs = await fetchPublicSheet();
    assert.ok(jobs.length > 100, 'Expected a populated public community listings spreadsheet');
    assert.ok(jobs.every(job => job.studioName && job.title && /^https?:|^mailto:/.test(job.link)));
    assert.ok(jobs.some(job => job.experienceLevel), 'Expected genuine experience-level metadata');
    console.log('Live anonymous spreadsheet records:', jobs.length);
  });
}
