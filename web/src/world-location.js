/**
 * Offline ISO country names + region detection using the version-pinned
 * world-countries npm package. No remote geocoding or network request.
 * Cities must be handled separately: a country dataset can't geocode cities.
 */
import worldCountries from 'world-countries';

const normalize = value => String(value ?? '')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const aliases = new Map();
const register = (raw, country) => {
  const key = normalize(raw);
  if (key.length < 4) return; // Don't confuse "us" or "in" with everyday words.
  if (!aliases.has(key)) aliases.set(key, country);
  else if (aliases.get(key)?.cca2 !== country.cca2) aliases.set(key, null);
};
for (const country of worldCountries) {
  for (const value of [
    country.name?.common, country.name?.official,
    ...(country.altSpellings || []),
    ...Object.values(country.translations || {})
      .flatMap(value => [value?.common, value?.official]),
  ]) if (value) register(value, country);
}
const uiRegion = country => {
  if (country.region === 'Americas')
    return country.subregion === 'South America' ? 'South America' : 'North America';
  return ['Europe', 'Africa', 'Asia', 'Oceania'].includes(country.region)
    ? country.region : '';
};

/**
 * Returns { countries, regions } for recognized whole country names in
 * freeform location data. "Colombo Sri Lanka" works without a comma.
 * No inference from application URLs, job titles or company names.
 */
export function detectCountryRegions(location) {
  const segments = String(location ?? '').split(/[,;|·/()]+/)
    .map(normalize).filter(Boolean);
  const matched = new Map();
  for (const segment of segments) {
    const words = segment.split(' ');
    // Exact match first; otherwise try full-word suffixes ("Colombo Sri Lanka").
    // If an alias is ambiguous between multiple countries, it is omitted.
    let country = aliases.get(segment);
    if (!country) for (let i = 1; i < words.length; i++) {
      const possible = aliases.get(words.slice(i).join(' '));
      if (possible) { country = possible; break; }
    }
    if (country) matched.set(country.cca2, country);
  }
  const items = [...matched.values()];
  return {
    countries: items.map(item => item.name.common),
    regions: [...new Set(items.map(uiRegion).filter(Boolean))],
  };
}
