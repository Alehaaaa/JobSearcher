// Optional, anonymous community listings. The Google Sheet is publicly
// readable through GViz CSV; no account, API key or server is required.
export const PUBLIC_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1eR2oAXOuflr8CZeGoz3JTrsgNj3KuefbdXJOmNtjEVM/edit?gid=0#gid=0';
export const PUBLIC_SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/1eR2oAXOuflr8CZeGoz3JTrsgNj3KuefbdXJOmNtjEVM/gviz/tq?tqx=out:csv&gid=0';

export function parseCSV(source) {
  const records = [];
  let row = [], field = '', quoted = false;
  const text = String(source || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(v => v !== '')) records.push(row);
      row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('Google Sheets CSV ended inside a quoted field');
  row.push(field);
  if (row.some(v => v !== '')) records.push(row);
  return records;
}

function jobLink(text) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    if (url.protocol === 'mailto:' && /^[^\s@?#]+@[^\s@?#]+/.test(url.pathname)) return url.href;
    return '';
  } catch {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? 'mailto:' + value : '';
  }
}

export function parsePublicSheetCSV(csv) {
  const rows = parseCSV(csv);
  const header = rows.shift() || [];
  if (!/studio/i.test(header[0] || '') || !/job title/i.test(header[8] || '') ||
      !/source\/contact/i.test(header[16] || '')) {
    throw new Error('Public spreadsheet columns have changed; cannot safely identify job records');
  }
  const jobs = [];
  const seen = new Set();
  for (const row of rows) {
    const studioName = String(row[0] || '').trim();
    const title = String(row[8] || '').trim();
    const link = jobLink(row[16]);
    if (!studioName || !title || !link) continue;
    const locationParts = [row[2], row[4], row[6]]
      .map(value => String(value || '').trim()).filter(Boolean);
    const location = [...new Set(locationParts.map(s => s.toLowerCase()))]
      .map(part => locationParts.find(s => s.toLowerCase() === part)).join(', ');
    const mode = String(row[12] || '').trim();
    const locationWithMode = /^remote$/i.test(mode) ? 'Remote' + (location ? ' · ' + location : '') : location;
    const key = [studioName, title, link, locationWithMode].map(s => s.toLowerCase()).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const sourceDate = String(row[14] || '').trim();
    const date = Date.parse(sourceDate);
    jobs.push({
      studioName, title, link, location: locationWithMode,
      experienceLevel: String(row[10] || '').trim(),
      workMode: mode,
      postedOn: Number.isFinite(date) ? new Date(date).toISOString() : '',
      source: 'Public Google Sheet', proxied: false, extraLink: '',
    });
  }
  return jobs.sort((a, b) => (b.postedOn || '').localeCompare(a.postedOn || '') ||
    a.studioName.localeCompare(b.studioName) || a.title.localeCompare(b.title));
}

export async function fetchPublicSheet() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(PUBLIC_SHEET_CSV_URL, {
      mode: 'cors', credentials: 'omit', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) throw new Error('Google Sheets public CSV returned HTTP ' + response.status);
    const csv = await response.text();
    if (csv.length > 4000000) throw new Error('Google Sheets public CSV exceeds 4 MB');
    const jobs = parsePublicSheetCSV(csv);
    if (!jobs.length) throw new Error('Google Sheets public CSV contained no verifiable application links');
    return jobs;
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error('Google Sheets public CSV request timed out', { cause });
    }
    throw cause;
  } finally { clearTimeout(timer); }
}
