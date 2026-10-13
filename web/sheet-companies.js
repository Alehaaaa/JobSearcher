// Group a publicly readable community sheet into real studio cards.
// Existing studios keep their configured branding; new ones use Google S2 favicons.
const fold = value => String(value ?? '').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/\s+/g, ' ');
const canonical = value => fold(value).split(' ')
  .filter(word => word && !['the','studio','studios','inc','incorporated','ltd',
    'limited','llc','corp','corporation','company'].includes(word)).join(' ');
const tokens = value => canonical(value).split(' ').filter(Boolean);
const generic = new Set(['studio','studios','animation','animations','vfx','visual',
  'effects','games','game','film','films','pictures','digital','creative',
  'productions','production','entertainment','the','and']);
const aliases = {
  'pixar animation studios':'pixar',
  'walt disney animation studios':'disney',
  'industrial light and magic':'ilm',
  'ilm':'ilm',
  'one of us studios':'oneofus',
  'cd projekt':'cdprojektred',
};

export function matchStudioName(name, studios) {
  const normalized = canonical(name);
  if (!normalized) return null;
  const aliasId = aliases[fold(name)];
  if (aliasId) {
    const match = studios.find(studio => studio.id === aliasId);
    if (match) return match;
  }
  const exact = studios.filter(studio => canonical(studio.name) === normalized);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const desired = tokens(name);
  const candidates = studios.map(studio => {
    const theirs = tokens(studio.name);
    const common = desired.filter(word => theirs.includes(word));
    const distinctive = common.filter(word => !generic.has(word) && word.length >= 4);
    const union = new Set([...desired, ...theirs]).size;
    const score = common.length / union;
    const prefix = normalized.startsWith(canonical(studio.name) + ' ') ||
      canonical(studio.name).startsWith(normalized + ' ');
    const allowed = (common.length >= 2 && common.some(word => !generic.has(word)) && score >= .65) ||
      (prefix && distinctive.length >= 1 && score >= .45) ||
      (distinctive.length >= 1 && desired.length === 1 && theirs.length <= 3 && score >= .33);
    return allowed ? { studio, score: score + (prefix ? .15 : 0) } : null;
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  // An ambiguous fuzzy match creates a separate card rather than mixing studios.
  return candidates.length && (candidates.length === 1 ||
    candidates[0].score - candidates[1].score >= .2) ? candidates[0].studio : null;
}

function iconDomain(link) {
  try {
    const parsed = new URL(link);
    if (parsed.protocol === 'mailto:') return parsed.pathname.split('@').pop();
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.hostname;
  } catch { /* Invalid source link */ }
  return '';
}

function uniqueId(name, used) {
  const root = 'sheet-' + (canonical(name).replace(/\s+/g, '-') || 'unknown');
  let id = root;
  for (let index = 2; used.has(id); index++) id = root + '-' + index;
  used.add(id);
  return id;
}

export function groupSheetStudios(configured, jobs) {
  const added = [];
  const byName = new Map();
  const jobsByStudio = new Map();
  const used = new Set(configured.map(studio => studio.id));
  for (const job of jobs) {
    if (!job?.studioName || !job.title || !job.link) continue;
    let studio = matchStudioName(job.studioName, configured);
    if (!studio) {
      const name = canonical(job.studioName);
      studio = byName.get(name);
      if (!studio) {
        const domain = iconDomain(job.link);
        studio = {
          id: uniqueId(job.studioName, used),
          name: job.studioName.trim(),
          website: /^https?:/i.test(job.link) ? job.link :
            'https://docs.google.com/spreadsheets/d/1eR2oAXOuflr8CZeGoz3JTrsgNj3KuefbdXJOmNtjEVM/edit?gid=0',
          careers_url: job.link,
          logo_url: domain ? 'https://www.google.com/s2/favicons?domain=' +
            encodeURIComponent(domain) + '&sz=128' : '',
          scraping: { strategy: 'static' },
          sheetOnly: true,
        };
        byName.set(name, studio);
        added.push(studio);
      }
    }
    if (!jobsByStudio.has(studio.id)) jobsByStudio.set(studio.id, []);
    jobsByStudio.get(studio.id).push(job);
  }
  return { studios: [...configured, ...added], jobsByStudio };
}

function normalLink(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()])
      if (/^utm_/i.test(key) || ['ref','source','gh_jid','trk'].includes(key.toLowerCase()))
        url.searchParams.delete(key);
    return url.href.replace(/\/$/, '').toLowerCase();
  } catch { return String(value ?? '').trim().toLowerCase(); }
}
const city = value => fold(String(value || '').split('·')[0].split(',')[0]);

export function mergeStudioJobs(existing, community, analyzeJob) {
  const result = [...existing];
  for (const contributed of community) {
    const candidate = analyzeJob(contributed);
    const found = result.findIndex(job =>
      normalLink(job.link) === normalLink(candidate.link) &&
      fold(job.title) === fold(candidate.title) &&
      (!city(job.location) || !city(candidate.location) ||
       city(job.location) === city(candidate.location)));
    if (found < 0) {
      result.push(candidate);
      continue;
    }
    const previous = result[found];
    const updated = { ...previous,
      location: (!previous.location || /^unspecified$/i.test(previous.location))
        ? candidate.location : previous.location,
      experienceLevel: previous.experienceLevel || candidate.experienceLevel,
      sheetBacked: true,
      postedOn: previous.postedOn || candidate.postedOn,
    };
    result[found] = analyzeJob(updated);
  }
  return result;
}
