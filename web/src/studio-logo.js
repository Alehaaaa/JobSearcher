// Community studios are untrusted input. In particular, job application URLs,
// job-board hosts and user-supplied logo_url are NOT evidence of company identity.
//
// Public contract:
//   resolveStudioBrand(studio, configured, options?) ->
//     { name, initials, logoUrl, matchedStudioId, verified }
//
// - studio: a sheet studio object with a name, or a plain studio name string.
// - configured: the independently loaded, trusted studio config (81 studios).
// - options.verifiedCompanyHomepages: OPTIONAL separately verified, explicitly
//   curated mapping of employer names to their own HTTPS homepage URLs/domains.
//   Do NOT pass application URLs, arbitrary data from Google Sheets, company-
//   name-to-domain guesses, or URLs from user-generated job listings.
// - options.verifiedLinkedInSlugs: optional CURATED LinkedIn employer slugs
//   (never guessed from company names or links to /jobs/view/ listings).
// - logoUrl favors a uniquely matched config's HTTPS logo_url. Otherwise it
//   uses Apistemic Logos for a separately verified company domain or LinkedIn
//   company slug, with Apistemic's default one-letter image on a logo miss.
//   On IMAGE NETWORK ERROR only, fallbackLogoUrl may use Google S2 favicons for
//   a verified homepage domain. Neither API guarantees unlimited availability.
// - Unknown/ambiguous companies without a trusted homepage use initials.
// - This function never fetches, and does not require credentials or a backend.
//   UI callers should memoize the result per studio/config revision, lazy-load
//   images, and render initials for an empty logoUrl or failed image.

const fold = value => String(value ?? '').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/\s+/g, ' ');

const legalOrStudioSuffix = new Set([
  'the', 'studio', 'studios', 'inc', 'incorporated', 'ltd', 'limited', 'llc',
  'corp', 'corporation', 'company', 'co',
]);
const descriptor = new Set([
  'animation', 'animations', 'vfx', 'visual', 'effects', 'film', 'films',
  'games', 'game', 'productions', 'production', 'entertainment', 'pictures',
]);
const aliases = Object.freeze({
  'pixar animation studios': 'pixar',
  'walt disney animation studios': 'disney',
  'disney animation studios': 'disney',
  'industrial light and magic': 'ilm',
  'ilm': 'ilm',
  'one of us studios': 'oneofus',
  'cd projekt': 'cdprojektred',
});

const canonical = name => fold(name).split(' ')
  .filter(word => word && !legalOrStudioSuffix.has(word)).join(' ');

function initialLetters(name) {
  const words = fold(name).split(' ').filter(Boolean);
  if (!words.length) return '?';
  const meaningful = words.filter(word => !legalOrStudioSuffix.has(word));
  const parts = meaningful.length ? meaningful : words;
  return (parts.length > 1
    ? parts.slice(0, 2).map(word => word[0]).join('')
    : parts[0].slice(0, 2)).toUpperCase();
}

function safeConfiguredLogo(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.href : '';
  } catch { return ''; }
}

// Generic recruitment hosts must never supply an employer's visual identity
// even when mistakenly present in a manually curated homepage map.
const thirdPartyHosts = [
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'jobvite.com',
  'greenhouse.io', 'lever.co', 'workable.com', 'myworkdayjobs.com',
  'dayforcehcm.com', 'smartrecruiters.com', 'ashbyhq.com',
  'teamtailor.com', 'recruitee.com', 'talent-soft.com', 'bamboohr.com',
  'google.com', 'googleusercontent.com', 'docs.google.com',
];

function validatedCompanyDomain(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const raw = value.trim();
  if (/[\s<>"'\\]/.test(raw)) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : 'https://' + raw);
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.port || url.search || url.hash) return '';
    const domain = url.hostname.toLowerCase().replace(/^www\./, '');
    if (domain.length > 253 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain) ||
        domain.startsWith('-') || domain.endsWith('-') ||
        domain.endsWith('.localhost') || domain.endsWith('.local') ||
        /^\d+\.\d+\.\d+\.\d+$/.test(domain) ||
        thirdPartyHosts.some(host => domain === host || domain.endsWith('.' + host))) return '';
    return domain;
  } catch { return ''; }
}

function trustedDomainForName(name, trustedHomepages) {
  if (!trustedHomepages || typeof trustedHomepages !== 'object') return '';
  const target = fold(name);
  if (!target) return '';
  const entries = trustedHomepages instanceof Map
    ? [...trustedHomepages.entries()]
    : Object.entries(trustedHomepages);
  const matching = entries.filter(([key]) => fold(key) === target);
  // Two entries which collapse to the same company name may belong to different
  // companies. Never pick an arbitrary logo when the mapping is ambiguous.
  if (matching.length !== 1) return '';
  return validatedCompanyDomain(matching[0][1]);
}

function trustedLinkedInSlugForName(name, trustedSlugs) {
  if (!trustedSlugs || typeof trustedSlugs !== 'object') return '';
  const entries = trustedSlugs instanceof Map
    ? [...trustedSlugs.entries()]
    : Object.entries(trustedSlugs);
  const matches = entries.filter(([key]) => fold(key) === fold(name));
  if (matches.length !== 1) return '';
  const slug = matches[0][1];
  return typeof slug === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,79}[a-z0-9])?$/.test(slug)
    ? slug : '';
}

function matchingConfiguredStudio(name, configured) {
  if (!Array.isArray(configured) || !configured.length) return null;
  const normalized = fold(name);
  const key = canonical(name);
  if (!key) return null;
  const valid = configured.filter(studio => studio && studio.id && studio.name);

  const aliasId = aliases[normalized];
  if (aliasId) {
    const candidates = valid.filter(studio => studio.id === aliasId);
    return candidates.length === 1 ? candidates[0] : null;
  }

  const exact = valid.filter(studio => canonical(studio.name) === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  // A broad parent label is not a specific studio. For example "Sony
  // Pictures" could be Animation or Imageworks, so never pick one by chance.
  if (valid.filter(studio => canonical(studio.name).startsWith(key + ' ')).length > 1) {
    return null;
  }

  // Only accept a unique base-name plus descriptive suffix, not generic
  // token overlap or edit-distance matching: "Sony Pictures Animations"
  // must not silently become "Sony Pictures Animation".
  const candidates = valid.filter(studio => {
    const base = canonical(studio.name);
    if (!base) return false;
    const baseParts = base.split(' ');
    const keyParts = key.split(' ');
    const baseShorter = baseParts.length < keyParts.length;
    const shorter = baseShorter ? baseParts : keyParts;
    const longer = baseShorter ? keyParts : baseParts;
    if (shorter.length < 2 || longer.length <= shorter.length) return false;
    if (!shorter.every((word, i) => word === longer[i])) return false;
    if (!shorter.some(word => !descriptor.has(word) && word.length >= 4)) return false;
    return longer.slice(shorter.length).every(word => descriptor.has(word));
  });
  return candidates.length === 1 ? candidates[0] : null;
}

export function resolveStudioBrand(studio, configured = [], options = {}) {
  const name = String(typeof studio === 'string' ? studio : studio?.name ?? '').trim();
  const matched = matchingConfiguredStudio(name, configured);
  const configuredLogo = matched ? safeConfiguredLogo(matched.logo_url) : '';
  const domain = configuredLogo ? '' : trustedDomainForName(name, options?.verifiedCompanyHomepages);
  const slug = !configuredLogo && !domain
    ? trustedLinkedInSlugForName(name, options?.verifiedLinkedInSlugs) : '';
  const apistemicLogo = domain ? 'https://logos-api.apistemic.com/domain:' + domain
    : slug ? 'https://logos-api.apistemic.com/linkedin:' + slug : '';
  const logoUrl = configuredLogo || apistemicLogo;
  return {
    name: matched?.name || name,
    initials: initialLetters(matched?.name || name),
    logoUrl,
    matchedStudioId: matched?.id || null,
    verified: Boolean(logoUrl),
    // Only send a second image request if Apistemic itself fails to load.
    // Its normal "not found" response already supplies a monogram.
    ...(apistemicLogo && domain ? {
      fallbackLogoUrl: 'https://www.google.com/s2/favicons?domain=' +
        encodeURIComponent(domain) + '&sz=128',
    } : {}),
  };
}
