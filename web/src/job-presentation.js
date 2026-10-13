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


/**
 * Heat map recovered from the original Python JobWidget:
 * green (0d) -> orange (5d) -> red (8d) -> grey (10d).
 * Its README mentions five days but executable source uses ten days.
 * Use locally tracked firstSeen only, never pretend old listed jobs are new.
 * Returns CSS custom properties or null for older / undated entries.
 */
export function jobAgeAppearance(job, now = Date.now()) {
  const input = job?.firstSeen;
  const when = typeof input === 'number' ? input : Date.parse(String(input || ''));
  if (!Number.isFinite(when) || when <= 0) return null;
  const day = 86_400_000;
  const age = Math.max(0, now - when);
  if (age >= 10 * day) return null;
  const targets = [
    [76, 175, 80], [255, 152, 0], [244, 67, 54], [85, 85, 85],
  ];
  const step = age <= 5 * day ? age / (5 * day)
    : age <= 8 * day ? 1 + (age - 5 * day) / (3 * day)
    : 2 + (age - 8 * day) / (2 * day);
  const i = Math.min(2, Math.floor(step));
  const ratio = Math.max(0, Math.min(1, step - i));
  // Fresh entries stay vibrant, then fade to 40% saturation after day one.
  const vibrancy = 1 - 0.6 * Math.min(1, age / day);
  const rgb = [0, 1, 2].map(channel => {
    const base = targets[i][channel] +
      (targets[i + 1][channel] - targets[i][channel]) * ratio;
    return Math.round(base * vibrancy + 85 * (1 - vibrancy));
  }).join(', ');
  return {
    '--job-age-border': 'rgba(' + rgb + ', .68)',
    '--job-age-tint': 'rgba(' + rgb + ', ' + (0.11 - age / (10 * day) * 0.07).toFixed(3) + ')',
  };
}
