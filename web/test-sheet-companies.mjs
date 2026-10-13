import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSheetStudios, matchStudioName, mergeStudioJobs } from './sheet-companies.js';
import { analyzeJob, matchesLevel, matchesLocation } from './src/filters.js';

const configured = [
  { id: 'pixar', name: 'Pixar' },
  { id: 'sonypicturesanimation', name: 'Sony Pictures Animation' },
  { id: 'sonypicturesimageworks', name: 'Sony Pictures Imageworks' },
  { id: 'bluezoo', name: 'Blue Zoo' },
  { id: 'oneofus', name: 'One of Us' },
];
const sheetJob = (studioName, title, link, location = 'London, United Kingdom', experienceLevel = 'Mid') =>
  ({ studioName, title, link, location, experienceLevel, source: 'Public Google Sheet' });

test('conservative fuzzy matches existing studios without merging unrelated Sony studios', () => {
  assert.equal(matchStudioName('Pixar Animation Studios', configured)?.id, 'pixar');
  assert.equal(matchStudioName('One Of Us Studios', configured)?.id, 'oneofus');
  assert.equal(matchStudioName('Blue Zoo Animations', configured)?.id, 'bluezoo');
  assert.equal(matchStudioName('Sony Pictures Animations', configured), null);
  assert.equal(matchStudioName('Unrelated Art Company', configured), null);
});

test('known company jobs attach to their original studio, not a sheet tile', () => {
  const groups = groupSheetStudios(configured, [
    sheetJob('Pixar Animation Studios', 'Senior Animator', 'https://pixar.com/jobs/456'),
  ]);
  assert.equal(groups.studios.length, configured.length);
  assert.equal(groups.jobsByStudio.get('pixar')?.length, 1);
  assert.ok(!groups.studios.some(studio => studio.id === 'community-sheet'));
});

test('new companies become independently addressable studio cards with Google favicon images', () => {
  const jobs = [
    sheetJob('Blue Sky Creative', 'FX TD', 'https://blueskycreative.com/jobs/1'),
    sheetJob('Blue Sky Creative', 'Animation Lead', 'https://blueskycreative.com/jobs/2'),
    sheetJob('Copper House', 'Producer', 'https://copperhouse.com/jobs/55'),
  ];
  const grouped = groupSheetStudios(configured, jobs);
  assert.equal(grouped.studios.length, configured.length + 2);
  const blueSky = grouped.studios.find(studio => studio.name === 'Blue Sky Creative');
  const copper = grouped.studios.find(studio => studio.name === 'Copper House');
  assert.equal(blueSky.id, 'sheet-blue-sky-creative');
  assert.equal(grouped.jobsByStudio.get(blueSky.id).length, 2);
  assert.equal(grouped.jobsByStudio.get(copper.id).length, 1);
  assert.equal(blueSky.logo_url, 'https://www.google.com/s2/favicons?domain=blueskycreative.com&sz=128');
  assert.equal(copper.logo_url, 'https://www.google.com/s2/favicons?domain=copperhouse.com&sz=128');
  assert.equal(blueSky.sheetOnly, true);
  assert.equal(blueSky.scraping.strategy, 'static');
});

test('duplicate jobs merge but preserve city-distinct roles with identical links', () => {
  const link = 'https://pixar.com/jobs/123';
  const real = [{ title: 'Animator', link, location: 'Emeryville', source: 'direct' }];
  const fromSheet = [
    sheetJob('Pixar', 'Animator', link + '?utm_source=google', 'Emeryville', 'Senior'),
    sheetJob('Pixar', 'Animator', link, 'Paris, France', 'Lead'),
  ];
  const merged = mergeStudioJobs(real, fromSheet, analyzeJob);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(job => job.location), ['Emeryville', 'Paris, France']);
  assert.ok(matchesLevel(merged[0], ['Senior']));
  assert.ok(matchesLevel(merged[1], ['Lead']));
  assert.ok(matchesLocation(merged[1], ['Europe'], []));
  assert.equal(merged[0].source, 'direct');
  assert.equal(merged[1].source, 'Public Google Sheet');
});

test('new community rows retain location and explicitly labeled seniority', () => {
  const job = sheetJob('Some Company', 'Artist', 'https://company.com/roles/1', 'Toronto, Canada', 'Junior');
  const merged = mergeStudioJobs([], [job], analyzeJob);
  assert.equal(merged.length, 1);
  assert.ok(matchesLocation(merged[0], ['North America'], ['Canada']));
  assert.ok(matchesLevel(merged[0], ['Junior']));
  assert.equal(merged[0].experienceLevel, 'Junior');
});

test('email-only new companies still receive a favicon and safe sheet-linked logo', () => {
  const groups = groupSheetStudios([], [
    sheetJob('Unknown Team', 'Animator', 'mailto:jobs@unknownteam.com'),
  ]);
  assert.equal(groups.studios.length, 1);
  assert.equal(groups.studios[0].logo_url,
    'https://www.google.com/s2/favicons?domain=unknownteam.com&sz=128');
  assert.match(groups.studios[0].website, /^https:\/\/docs\.google\.com\/spreadsheets\//);
});
