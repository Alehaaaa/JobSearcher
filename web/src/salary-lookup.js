/**
 * Role-specific salary RESEARCH links, not a Glassdoor API or an estimate.
 *
 * Glassdoor does not offer a public, unrestricted CORS salary feed for static
 * GitHub Pages. These are observed public Glassdoor salary pages; the visitor
 * checks current pay ranges on Glassdoor itself, selecting the relevant city.
 * Never scrape Glassdoor, embed its content, or invent salary values.
 *
 * Keep the mapping deliberately conservative: only roles with validated pages
 * receive a quick-access link. All URLs are fixed literals; no user/CSV input
 * is interpolated into an external URL.
 */
const GLASSDOOR_PAGES = Object.freeze({
  animator: 'https://www.glassdoor.com/Salaries/animator-salary-SRCH_KO0,8.htm',
  senior: 'https://www.glassdoor.com/Salaries/senior-animator-salary-SRCH_KO0,15.htm',
  character: 'https://www.glassdoor.com/Salaries/character-animator-salary-SRCH_KO0,18.htm',
  threeD: 'https://www.glassdoor.com/Salaries/3d-animator-salary-SRCH_KO0,11.htm',
});

export function glassdoorAnimatorSalaryLookup(job) {
  const title = String(job?.title ?? '').normalize('NFKC').trim().toLowerCase();
  if (!/\banimators?\b/.test(title)) return null;
  // Match the clearest supported profession rather than guessing niche salaries.
  const senior = /\b(senior|sr\.?|lead|principal|supervising)\b/.test(title);
  const character = /\bcharacter\b/.test(title);
  const threeD = /\b3d\b|\b3-d\b|\bthree[- ]dimensional\b/.test(title);
  const role = senior ? 'Senior Animator' : character ? 'Character Animator'
    : threeD ? '3D Animator' : 'Animator';
  const url = senior ? GLASSDOOR_PAGES.senior
    : character ? GLASSDOOR_PAGES.character
    : threeD ? GLASSDOOR_PAGES.threeD : GLASSDOOR_PAGES.animator;
  const location = String(job?.location || '').trim();
  const locationLabel = location && !/^(?:unspecified|remote|worldwide|anywhere)$/i.test(location)
    ? location : '';
  return {
    url,
    role,
    location: locationLabel,
    tooltip: 'Research ' + role + ' salary ranges on Glassdoor' +
      (locationLabel ? ' — select ' + locationLabel + ' as the location' : ' — select your location'),
  };
}
