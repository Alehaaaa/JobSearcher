// Align the region and seniority conventions with UI/ContentView.swift.
export const REGIONS = [
  'Europe', 'North America', 'South America', 'Asia', 'Africa',
  'Oceania', 'Remote', 'Unspecified',
];

export const LEVELS = [
  'Director', 'Lead', 'Senior', 'Mid', 'Junior', 'Intern', 'Unspecified',
];

const REGION_ALIASES = {
  Europe: 'europe|europa|uk|united kingdom|england|scotland|ireland|france|paris|bordeaux|london|manchester|germany|berlin|munich|münchen|frankfurt|spain|españa|madrid|barcelona|tenerife|poland|warsaw|wroclaw|wrocław|czechia|czech republic|prague|slovakia|bratislava|italy|rome|portugal|netherlands|amsterdam|belgium|sweden|stockholm|norway|denmark|finland|austria|switzerland|zurich|zürich|luxembourg|contern|montpellier|kilkenny|dublin|newcastle upon tyne|bulgaria|sofia|romania|bucharest|ukraine|kyiv|odesa|estonia|tallinn|malta|st julians|saint julians|gibraltar|bosnia and herzegovina|sarajevo|croatia|zagreb|serbia|belgrade|slovenia|ljubljana|latvia|riga|lithuania|vilnius|hungary|budapest|greece|athens|cyprus|nicosia|iceland|reykjavik|north macedonia|skopje|montenegro|podgorica|moldova|chisinau',
  'North America': 'united states|usa|us|canada|california|los angeles|burbank|glendale|san francisco|pasadena|universal city|new york|boston|atlanta|georgia|oregon|portland|hillsboro|vancouver|toronto|montreal|montréal|quebec|québec|ottawa|british columbia|bc|ontario|montpelier|vermont|mexico|méxico|mexico city|north america',
  'South America': 'brazil|brasil|argentina|chile|colombia|peru|perú|uruguay|paraguay|ecuador|venezuela|bolivia|south america|latin america',
  Asia: 'asia|japan|tokyo|india|mumbai|bengaluru|bangalore|hyderabad|china|shanghai|beijing|hong kong|korea|seoul|singapore|taiwan|thailand|vietnam|philippines|malaysia|indonesia|united arab emirates|dubai|uae|israel|turkey|türkiye|kazakhstan|almaty|astana|uzbekistan|tashkent|samarkand|kyrgyzstan|bishkek',
  Africa: 'africa|south africa|cape town|johannesburg|morocco|egypt|nigeria|kenya|mauritius|saint pierre',
  Oceania: 'oceania|australia|sydney|melbourne|brisbane|north lakes|adelaide|new zealand|wellington|auckland',
  Remote: 'remote|teletrabajo|work from home|anywhere',
};

const COUNTRY_ALIASES = {
  Australia: 'australia|sydney|melbourne|brisbane|north lakes|adelaide',
  Austria: 'austria|vienna|wien',
  Belgium: 'belgium|brussels',
  Brazil: 'brazil|brasil|são paulo|sao paulo',
  'Bosnia and Herzegovina': 'bosnia and herzegovina|bosnia|herzegovina|sarajevo',
  Bulgaria: 'bulgaria|sofia',
  Canada: 'canada|vancouver|toronto|montreal|montréal|quebec|québec|ottawa|british columbia|ontario',
  China: 'china|shanghai|beijing|hong kong',
  Croatia: 'croatia|zagreb',
  Cyprus: 'cyprus|nicosia',
  Czechia: 'czechia|czech republic|prague',
  Denmark: 'denmark|copenhagen',
  Estonia: 'estonia|tallinn',
  France: 'france|paris|bordeaux|montpellier|lyon',
  Germany: 'germany|berlin|munich|münchen|frankfurt|hamburg',
  Gibraltar: 'gibraltar',
  Greece: 'greece|athens',
  Hungary: 'hungary|budapest',
  Iceland: 'iceland|reykjavik',
  India: 'india|mumbai|bengaluru|bangalore|hyderabad|pune',
  Ireland: 'ireland|dublin|kilkenny',
  Italy: 'italy|rome|milan',
  Japan: 'japan|tokyo|osaka',
  Kazakhstan: 'kazakhstan|almaty|astana',
  Kyrgyzstan: 'kyrgyzstan|bishkek',
  Luxembourg: 'luxembourg|contern',
  Latvia: 'latvia|riga',
  Lithuania: 'lithuania|vilnius',
  Mauritius: 'mauritius|saint pierre',
  Malta: 'malta|st julians|saint julians',
  Moldova: 'moldova|chisinau',
  Montenegro: 'montenegro|podgorica',
  Mexico: 'mexico|méxico|mexico city',
  Netherlands: 'netherlands|amsterdam',
  'New Zealand': 'new zealand|wellington|auckland',
  'North Macedonia': 'north macedonia|skopje',
  Poland: 'poland|warsaw|wroclaw|wrocław',
  Portugal: 'portugal|lisbon|porto',
  Romania: 'romania|bucharest',
  Serbia: 'serbia|belgrade',
  Slovenia: 'slovenia|ljubljana',
  Slovakia: 'slovakia|bratislava',
  'South Korea': 'south korea|korea|seoul',
  Spain: 'spain|españa|madrid|barcelona|tenerife|valencia',
  Sweden: 'sweden|stockholm',
  Switzerland: 'switzerland|zurich|zürich',
  'United Kingdom': 'united kingdom|england|scotland|wales|uk|london|manchester|newcastle upon tyne|bristol',
  'United States': 'united states|usa|us|california|los angeles|burbank|glendale|san francisco|pasadena|universal city|new york|boston|atlanta|oregon|portland|hillsboro|chicago|emeryville|montpelier|vermont',
  'United Arab Emirates': 'united arab emirates|uae|dubai',
  Ukraine: 'ukraine|kyiv|odesa',
  Uzbekistan: 'uzbekistan|tashkent|samarkand',
};

const LEVEL_TERMS = {
  Director: 'director|directora|directeur|directrice|vp|vice[ -]president|chief|cto|ceo|cfo|coo|executive director',
  Lead: 'lead|leader|team[ -]lead|head of|principal|lider|líder|tech lead|supervisor|supervisora|supervising|superviseur|superviseuse|supv?\\.?|manager|management|mgr\\.?|responsable|gerente',
  Senior: 'senior|sénior|sr\\.?|sen\\.?|staff|expert',
  Mid: 'mid(?:[ -]level)?|midlevel|middle|intermediate|medior|midsenior',
  Junior: 'junior|jr\\.?|entry[ -]level|graduate|débutant|debutant|early career|associate|associated|assoc\\.?|asociad[oa]|associé|associée',
  Intern: 'intern|internship|internships|intern(?:e)?|trainee|apprentice|apprenticeship|stagiaire|stage|prácticas|practicas|becari[oa]|working student|placement',
};

const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const escapeRegex = str => [...str].map(ch => '[]{}()*+?.\\^$|'.includes(ch) ? '\\' + ch : ch).join('');
const aliasRegex = value => new RegExp('(?:^|[^a-z])(?:' + value.split('|').map(item => escapeRegex(fold(item))).join('|') + ')(?=$|[^a-z])');
const regionPatterns = Object.fromEntries(Object.entries(REGION_ALIASES).map(([key, aliases]) => [key, aliasRegex(aliases)]));
const countryPatterns = Object.fromEntries(Object.entries(COUNTRY_ALIASES).map(([key, aliases]) => [key, aliasRegex(aliases)]));
const levelPatterns = Object.fromEntries(Object.entries(LEVEL_TERMS).map(([key, source]) => [key, new RegExp('(?:^|[^a-z])(?:' + fold(source) + ')(?=$|[^a-z])')]));

export function analyzeJob(job) {
  const location = fold(job.location);
  const title = fold(job.title);
  const regions = Object.keys(regionPatterns).filter(key => regionPatterns[key].test(location));
  if (!regions.length) regions.push('Unspecified');
  const countries = Object.keys(countryPatterns).filter(key => countryPatterns[key].test(location));
  // Contributed spreadsheet rows include an explicit seniority field. Prefer
  // that label when present rather than guessing from a title like "Artist".
  const levelInput = job.experienceLevel ? fold(job.experienceLevel) : title;
  const levels = Object.keys(levelPatterns).filter(key => levelPatterns[key].test(levelInput));
  if (!levels.length) levels.push('Unspecified');
  return { ...job, regions, countries, levels };
}

export function createSearchMatcher(query) {
  if (!query.trim()) return { test: () => true, literalFallback: false };
  try {
    const re = new RegExp(query, 'i');
    return { test: job => re.test([job.title, job.location, job.studioName].filter(Boolean).join(' ')), literalFallback: false };
  } catch {
    const search = fold(query);
    return { test: job => fold([job.title, job.location, job.studioName].filter(Boolean).join(' ')).includes(search), literalFallback: true };
  }
}

export function matchesLocation(job, regions, countries) {
  if (!regions.length && !countries.length) return true;
  return regions.some(region => job.regions.includes(region)) || countries.some(country => job.countries.includes(country));
}

export function matchesLevel(job, levels) {
  return !levels.length || levels.some(level => job.levels.includes(level));
}

export function countLocations(jobs) {
  const regions = Object.fromEntries(REGIONS.map(region => [region, 0]));
  const countries = {};
  for (const job of jobs) {
    for (const region of job.regions) regions[region]++;
    for (const country of job.countries) countries[country] = (countries[country] || 0) + 1;
  }
  return { regions, countries };
}

export function countLevels(jobs) {
  const levels = Object.fromEntries(LEVELS.map(level => [level, 0]));
  for (const job of jobs) for (const level of job.levels) levels[level]++;
  return levels;
}
