import test from 'node:test';
import assert from 'node:assert/strict';
import { displayLevel, displayLocation, relativeJobTime } from './src/job-presentation.js';

test('every job has exactly one compact level and a location fallback', () => {
  assert.equal(displayLevel({ levels: ['Lead', 'Senior'] }), 'Lead');
  assert.equal(displayLevel({ levels: ['Unspecified'] }), 'Unspecified');
  assert.equal(displayLevel({ levels: ['Intern'] }), 'Intern');
  assert.equal(displayLocation({ location: 'London, UK' }), 'London, UK');
  assert.equal(displayLocation({ location: '' }), 'Unspecified');
});

test('relative time uses calendar days and concise weeks, months and years', () => {
  const noon = Date.parse('2026-10-13T12:00:00');
  const daysAgo = days => new Date(noon - days * 86400000).toISOString();
  assert.equal(relativeJobTime(daysAgo(0), noon), 'Today');
  assert.equal(relativeJobTime(daysAgo(1), noon), 'Yesterday');
  assert.equal(relativeJobTime(daysAgo(3), noon), '3d ago');
  assert.equal(relativeJobTime(daysAgo(14), noon), '2w ago');
  assert.equal(relativeJobTime(daysAgo(65), noon), '2mo ago');
  assert.equal(relativeJobTime(daysAgo(380), noon), '1y ago');
  assert.equal(relativeJobTime('invalid', noon), '');
});

test('community countries classify into geography filters instead of Unspecified', async () => {
  const { analyzeJob, matchesLocation } = await import('./src/filters.js');
  const examples = [
    ['Tallinn, Estonia', 'Europe', 'Estonia'],
    ["St. Julian's, Malta", 'Europe', 'Malta'],
    ['Sarajevo, Bosnia and Herzegovina', 'Europe', 'Bosnia and Herzegovina'],
    ['Gibraltar', 'Europe', 'Gibraltar'],
    ['Kazakhstan', 'Asia', 'Kazakhstan'],
    ['Uzbekistan', 'Asia', 'Uzbekistan'],
    ['Almaty, Kazakhstan', 'Asia', 'Kazakhstan'],
    ['Culver City, California', 'North America', 'United States'],
  ];
  for (const [location, region, country] of examples) {
    const job = analyzeJob({ title: 'Artist', location, experienceLevel: 'Mid' });
    assert.ok(job.regions.includes(region), location + ' lacks region ' + region);
    assert.ok(job.countries.includes(country), location + ' lacks country ' + country);
    assert.ok(!job.regions.includes('Unspecified'), location + ' wrongly unspecified');
    assert.ok(matchesLocation(job, [region], []), location + ' region filter failed');
    assert.ok(matchesLocation(job, [], [country]), location + ' country filter failed');
  }
});

test('offline studio configuration has the same Blur fallback as JobSearcher/main', async () => {
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('./data/studios.json', import.meta.url), 'utf8'));
  const blur = config.find(studio => studio.id === 'blur');
  assert.deepEqual(blur.scraping.map.location,
    { selector: 'p.body__secondary', default: 'Culver City, California' });
});
