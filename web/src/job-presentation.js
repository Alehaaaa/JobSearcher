// Keep the same compact metadata convention on every job card.
const DISPLAY_LEVELS = ['Director', 'Lead', 'Senior', 'Mid', 'Junior', 'Intern'];

export function displayLevel(job) {
  const levels = Array.isArray(job?.levels) ? job.levels : [];
  return DISPLAY_LEVELS.find(level => levels.includes(level)) || 'Unspecified';
}

export function relativeJobTime(value, now = Date.now()) {
  const time = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(time) || time <= 0) return '';
  const delta = Math.max(0, now - time);
  const day = 86400000;
  // Calendar-day language is more natural than saying "23h ago" yesterday.
  const today = new Date(now);
  const then = new Date(time);
  const dayIndex = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / day;
  const days = Math.max(0, dayIndex(today) - dayIndex(then));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + 'd ago';
  if (days < 30) return Math.floor(days / 7) + 'w ago';
  if (days < 365) return Math.floor(days / 30) + 'mo ago';
  return Math.floor(days / 365) + 'y ago';
}

export function displayLocation(job) {
  return String(job?.location || '').trim() || 'Unspecified';
}
