import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveStudioBrand } from './src/studio-logo.js';
import { VERIFIED_STUDIO_HOMEPAGES } from './src/verified-studio-homepages.js';

const configured = JSON.parse(await readFile(new URL('./data/studios.json', import.meta.url), 'utf8'));
const byId = id => configured.find(studio => studio.id === id);

test('known studio matches its trusted config logo, not an untrusted sheet logo', () => {
  const expected = byId('pixar');
  const result = resolveStudioBrand({
    name: 'Pixar Animation Studios',
    logo_url: 'https://evil.invalid/pixar.svg',
    careers_url: 'https://www.linkedin.com/jobs/view/123',
  }, configured);
  assert.deepEqual(result, {
    name: expected.name,
    initials: 'PI',
    logoUrl: expected.logo_url,
    matchedStudioId: 'pixar',
    verified: true,
  });
});

test('known aliases resolve independently of the application link', () => {
  for (const [name, id] of [
    ['Walt Disney Animation Studios', 'disney'],
    ['Industrial Light & Magic', 'ilm'],
    ['One of Us Studios', 'oneofus'],
    ['CD Projekt', 'cdprojektred'],
    ['Blue Zoo Animations', 'bluezoo'],
    ['DNEG', 'dneg'],
  ]) {
    const result = resolveStudioBrand({ name, link: 'https://apply.workable.com/agency/j/55' }, configured);
    assert.equal(result.matchedStudioId, id, name);
    assert.equal(result.logoUrl, byId(id).logo_url, name);
  }
});

test('unrelated and ambiguous employers never borrow an existing logo', () => {
  for (const name of [
    'Sony Pictures', 'Sony Pictures Animations', 'Animation Studios',
    'Moon Animation', 'Unknown Arts', 'Unknown Arts Studio', '',
  ]) {
    const result = resolveStudioBrand({
      name, logo_url: 'https://www.google.com/s2/favicons?domain=linkedin.com',
      careers_url: 'https://www.linkedin.com/jobs/view/9999',
    }, configured);
    assert.equal(result.matchedStudioId, null, name);
    assert.equal(result.logoUrl, '', name);
    assert.equal(result.verified, false, name);
    assert.ok(result.initials.length > 0, name);
  }
});

test('initials are stable neutral placeholders; no network or favicon access', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Logo resolver must never fetch'); };
  try {
    const first = resolveStudioBrand({
      name: 'Copper House', link: 'https://jobs.jobvite.com/employer/123',
      website: 'https://linkedin.com',
    }, configured);
    assert.deepEqual(first, {
      name: 'Copper House', initials: 'CH', logoUrl: '', matchedStudioId: null,
      verified: false,
    });
    assert.deepEqual(resolveStudioBrand({ name: 'Copper House', careers_url: 'mailto:jobs@copperhouse.com' }, configured), first);
    assert.equal(resolveStudioBrand('', configured).initials, '?');
  } finally { globalThis.fetch = originalFetch; }
});

test('only configured, secure, absolute logo URLs are trusted', () => {
  const fake = [
    { id: 'test', name: 'Test Agency', logo_url: 'http://untrusted.test/logo.png' },
  ];
  assert.deepEqual(resolveStudioBrand('Test Agency', fake), {
    name: 'Test Agency', initials: 'TA', logoUrl: '',
    matchedStudioId: 'test', verified: false,
  });
  assert.equal(resolveStudioBrand('Test Agency', [{ ...fake[0], logo_url: 'javascript:alert(1)' }]).logoUrl, '');
  assert.equal(resolveStudioBrand('Test Agency', [{ ...fake[0], logo_url: 'https://person:secret@example.test/logo.png' }]).logoUrl, '');
  assert.equal(resolveStudioBrand('Test Agency', [{ ...fake[0], logo_url: 'https://cdn.example.test/test.svg' }]).logoUrl, 'https://cdn.example.test/test.svg');
});

test('duplicate configured matches remain unresolved instead of choosing arbitrary branding', () => {
  const ambiguous = [
    { id: 'first', name: 'Example Studio', logo_url: 'https://first.test/favicon.ico' },
    { id: 'second', name: 'Example Studios', logo_url: 'https://second.test/favicon.ico' },
  ];
  assert.equal(resolveStudioBrand('Example Studio', ambiguous).matchedStudioId, null);
  assert.equal(resolveStudioBrand('Example Studio', ambiguous).logoUrl, '');
});

test('Apistemic domain logo uses only a separately verified employer homepage, never a job application URL', () => {
  const sheetStudio = {
    name: 'Copper House',
    logo_url: 'https://evil.example/logo.svg',
    website: 'https://www.linkedin.com/jobs/view/9999',
    careers_url: 'https://jobs.jobvite.com/recruiter',
  };
  assert.equal(resolveStudioBrand(sheetStudio, configured).logoUrl, '');
  assert.deepEqual(resolveStudioBrand(sheetStudio, configured, {
    verifiedCompanyHomepages: { 'Copper House': 'https://www.copperhouse.com/about' },
  }), {
    name: 'Copper House', initials: 'CH',
    logoUrl: 'https://logos-api.apistemic.com/domain:copperhouse.com',
    fallbackLogoUrl: 'https://www.google.com/s2/favicons?domain=copperhouse.com&sz=128',
    matchedStudioId: null, verified: true,
  });
  assert.equal(resolveStudioBrand('Copper House', configured, {
    verifiedCompanyHomepages: new Map([['copper house', 'copperhouse.com']]),
  }).logoUrl, 'https://logos-api.apistemic.com/domain:copperhouse.com');
});

test('trusted configured logo takes precedence over a homepage favicon', () => {
  const brand = resolveStudioBrand('Pixar Animation Studios', configured, {
    verifiedCompanyHomepages: { 'Pixar Animation Studios': 'https://pixar.com' },
  });
  assert.equal(brand.logoUrl, byId('pixar').logo_url);
  assert.equal(brand.matchedStudioId, 'pixar');
});

test('unverified, unsafe, and recruiting domains never produce favicons', () => {
  const invalid = [
    'https://linkedin.com/jobs/view/123',
    'https://jobs.lever.co/openings',
    'https://apply.workable.com/agency/jobs',
    'https://boards.greenhouse.io/jobs',
    'https://docs.google.com/spreadsheets/d/sheet',
    'http://realcompany.com',
    'https://user:password@realcompany.com',
    'https://realcompany.com?token=secret',
    'https://127.0.0.1',
    'http://localhost',
    'https://localhost',
    'javascript:alert(1)',
    'not a website',
  ];
  for (const value of invalid) {
    assert.equal(resolveStudioBrand('Copper House', configured, {
      verifiedCompanyHomepages: { 'Copper House': value },
    }).logoUrl, '', value);
  }
  assert.equal(resolveStudioBrand('Copper House', configured, {
    verifiedCompanyHomepages: {
      'Copper House': 'https://copperhouse.com',
      'copper-house': 'https://wrong-brand.com',
    },
  }).logoUrl, '', 'ambiguous entries must not silently pick a company logo');
});

test('URL generation is deterministic and never makes third-party API requests', () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('No remote requests inside resolver'); };
  try {
    const options = { verifiedCompanyHomepages: { 'Copper House': 'copperhouse.com' } };
    const first = resolveStudioBrand('Copper House', configured, options);
    const second = resolveStudioBrand('Copper House', configured, options);
    assert.deepEqual(first, second);
    assert.equal(first.logoUrl, 'https://logos-api.apistemic.com/domain:copperhouse.com');
    assert.equal(first.fallbackLogoUrl, 'https://www.google.com/s2/favicons?domain=copperhouse.com&sz=128');
  } finally { globalThis.fetch = oldFetch; }
});

test('verified LinkedIn company slug supports Apistemic without guessing from an application URL', () => {
  const company = { name: 'Copper House', link: 'https://www.linkedin.com/jobs/view/1234' };
  assert.equal(resolveStudioBrand(company, configured).logoUrl, '');
  assert.deepEqual(resolveStudioBrand(company, configured, {
    verifiedLinkedInSlugs: { 'Copper House': 'copper-house' },
  }), {
    name: 'Copper House', initials: 'CH',
    logoUrl: 'https://logos-api.apistemic.com/linkedin:copper-house',
    matchedStudioId: null, verified: true,
  });
  assert.equal(resolveStudioBrand(company, configured, {
    verifiedLinkedInSlugs: { 'Copper House': 'linkedin.com/company/copper-house' },
  }).logoUrl, '');
});

test('curated real company domains generate Apistemic images with Google error fallback', () => {
  for (const [name, domain] of Object.entries(VERIFIED_STUDIO_HOMEPAGES)) {
    const result = resolveStudioBrand({
      name, link: 'https://www.linkedin.com/jobs/view/23425',
    }, [], { verifiedCompanyHomepages: VERIFIED_STUDIO_HOMEPAGES });
    assert.equal(result.logoUrl, 'https://logos-api.apistemic.com/domain:' + domain, name);
    assert.equal(result.fallbackLogoUrl, 'https://www.google.com/s2/favicons?domain=' +
      encodeURIComponent(domain) + '&sz=128', name);
    assert.equal(result.verified, true, name);
  }
  assert.ok(Object.keys(VERIFIED_STUDIO_HOMEPAGES).length >= 55);
  assert.equal(resolveStudioBrand('Completely Unknown Studio', [],
    { verifiedCompanyHomepages: VERIFIED_STUDIO_HOMEPAGES }).logoUrl, '');
});
