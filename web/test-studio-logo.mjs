import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveStudioBrand } from './src/studio-logo.js';

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
