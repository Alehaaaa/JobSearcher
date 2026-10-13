// Community studios are untrusted input. In particular, job application URLs,
// job-board hosts and user-supplied logo_url are NOT evidence of company identity.
//
// Public contract:
//   resolveStudioBrand(studio, configured) ->
//     { name, initials, logoUrl, matchedStudioId, verified }
//
// - studio: a sheet studio object with a name, or a plain studio name string.
// - configured: the independently loaded, trusted studio config (81 studios).
// - logoUrl is nonempty ONLY when a uniquely matched configured studio has a
//   valid HTTPS logo_url. Unknown/ambiguous names use initials instead.
// - This function never fetches, adds domains or generates favicon URLs.
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

export function resolveStudioBrand(studio, configured = []) {
  const name = String(typeof studio === 'string' ? studio : studio?.name ?? '').trim();
  const matched = matchingConfiguredStudio(name, configured);
  const logoUrl = matched ? safeConfiguredLogo(matched.logo_url) : '';
  return {
    name: matched?.name || name,
    initials: initialLetters(matched?.name || name),
    logoUrl,
    matchedStudioId: matched?.id || null,
    verified: Boolean(logoUrl),
  };
}
