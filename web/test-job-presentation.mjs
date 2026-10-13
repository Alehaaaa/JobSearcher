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
