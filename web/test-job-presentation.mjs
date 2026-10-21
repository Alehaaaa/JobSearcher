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

test('maintained countries and city aliases classify Milano and Sri Lanka correctly', async () => {
  const { analyzeJob, matchesLocation } = await import('./src/filters.js');
  const examples = [
    ['Milano', 'Europe', 'Italy'],
    ['Milano, Italia', 'Europe', 'Italy'],
    ['Colombo, Sri Lanka', 'Asia', 'Sri Lanka'],
    ['Colombo Sri Lanka', 'Asia', 'Sri Lanka'],
    ['Sri Lanka', 'Asia', 'Sri Lanka'],
    ['Kathmandu, Nepal', 'Asia', 'Nepal'],
    ['Auckland, New Zealand', 'Oceania', 'New Zealand'],
    ['Reykjavik, Iceland', 'Europe', 'Iceland'],
  ];
  for (const [location, region, country] of examples) {
    const job = analyzeJob({ title: 'Lighting Artist', location });
    assert.ok(job.regions.includes(region), location + ' missing region ' + region);
    assert.ok(job.countries.includes(country), location + ' missing country ' + country);
    assert.ok(!job.regions.includes('Unspecified'), location + ' incorrectly unspecified');
    assert.ok(matchesLocation(job, [], [country]), location + ' country filter broken');
  }
  const unknown = analyzeJob({ title: 'Artist', location: 'Imaginary City' });
  assert.deepEqual(unknown.regions, ['Unspecified']);
});

test('original ten-day job discovery heat map is stable and fades to neutral', async () => {
  const { jobAgeAppearance } = await import('./src/job-presentation.js');
  const now = Date.parse('2026-10-13T12:00:00Z');
  const daysAgo = days => now - days * 86_400_000;
  assert.match(jobAgeAppearance({ firstSeen: daysAgo(0) }, now)['--job-age-border'], /76, 175, 80/);
  assert.ok(jobAgeAppearance({ firstSeen: daysAgo(5) }, now));
  assert.ok(jobAgeAppearance({ firstSeen: daysAgo(8) }, now));
  assert.equal(jobAgeAppearance({ firstSeen: daysAgo(10) }, now), null);
  assert.equal(jobAgeAppearance({ postedOn: new Date(now).toISOString() }, now), null);
  assert.equal(jobAgeAppearance({ firstSeen: 'invalid' }, now), null);
  assert.equal(jobAgeAppearance({ firstSeen: daysAgo(0) }, now)['--job-age-tint'], 'rgba(76, 175, 80, 0.110)');
});

test('Glassdoor animator salary lookup uses validated public pages and never guesses figures', async () => {
  const { glassdoorAnimatorSalaryLookup: lookup } = await import('./src/salary-lookup.js');
  const cases = [
    ['Animator', 'animator-salary-SRCH_KO0,8.htm', 'Animator'],
    ['Junior Animator', 'animator-salary-SRCH_KO0,8.htm', 'Animator'],
    ['Senior Animator', 'senior-animator-salary-SRCH_KO0,15.htm', 'Senior Animator'],
    ['Lead Gameplay Animator', 'senior-animator-salary-SRCH_KO0,15.htm', 'Senior Animator'],
    ['3D Animator', '3d-animator-salary-SRCH_KO0,11.htm', '3D Animator'],
    ['Character Animator', 'character-animator-salary-SRCH_KO0,18.htm', 'Character Animator'],
    ['Senior Character Animator', 'senior-animator-salary-SRCH_KO0,15.htm', 'Senior Animator'],
  ];
  for (const [title, suffix, role] of cases) {
    const value = lookup({ title, location: 'London, United Kingdom' });
    assert.equal(value.url, 'https://www.glassdoor.com/Salaries/' + suffix, title);
    assert.equal(value.role, role, title);
    assert.equal(value.location, 'London, United Kingdom');
    assert.match(value.tooltip, /select London, United Kingdom as the location/);
    assert.deepEqual(Object.keys(value).sort(), ['location','role','tooltip','url']);
  }
});
test('Glassdoor links stay fixed, safe and limited to animator roles', async () => {
  const { glassdoorAnimatorSalaryLookup: lookup } = await import('./src/salary-lookup.js');
  for (const title of [
    'Lighting Artist', 'Animation Supervisor', 'VFX Animator Assistant Manager',
    'Layout Artist', '', null,
  ]) {
    if (title === 'VFX Animator Assistant Manager') continue; // Contains a real Animator role.
    assert.equal(lookup({ title }), null, String(title));
  }
  assert.equal(lookup({ title: 'VFX Animator Assistant Manager' }).role, 'Animator');
  const unknown = lookup({
    title: 'Animator https://malicious.example/script',
    location: '<img src=x onerror=alert(1)>',
    link: 'javascript:alert(1)',
  });
  assert.ok(unknown);
  assert.equal(unknown.url, 'https://www.glassdoor.com/Salaries/animator-salary-SRCH_KO0,8.htm');
  assert.equal(lookup({ title: 'Animator', location: 'Remote' }).location, '');
  assert.equal(lookup(null), null);
});
