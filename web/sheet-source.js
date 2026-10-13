// Anonymous community listings, fetched directly from Google's public GViz
// CSV endpoint. No login, API key, backend, relay or third-party CORS proxy:
// a sheet not publicly readable anonymously is not fetched by this module.
export const PUBLIC_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1eR2oAXOuflr8CZeGoz3JTrsgNj3KuefbdXJOmNtjEVM/edit?gid=0#gid=0';
export const PUBLIC_SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/1eR2oAXOuflr8CZeGoz3JTrsgNj3KuefbdXJOmNtjEVM/gviz/tq?tqx=out:csv&gid=0';

const SHEET_ID = /^[a-zA-Z0-9_-]{15,150}$/;
const MAX_CSV_BYTES = 4_000_000;
const DEFAULT_TIMEOUT_MS = 18_000;

/**
 * Normalize a shared Google spreadsheet link to a direct, anonymous GViz
 * CSV URL. Supports /edit?gid=, /view, /export?format=csv, /gviz/tq,
 * /pubhtml and the bare spreadsheet ID. The public /d/e/.../pubhtml URL
 * cannot be converted to a /d/<id>/gviz/tq URL and is rejected explicitly.
 *
 * Accepts a URL, a previous parseSheetReference result, or
 * {url, name?, gid?, sheet?}. Optional name is a local display label; it
 * never changes the fetch destination.
 */
export function parseSheetReference(input = PUBLIC_SHEET_URL) {
  const object = input !== null && typeof input === 'object' && !Array.isArray(input);
  const raw = object ? input.url ?? input.sheetUrl ?? input.href ?? input.csvUrl : input;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Enter a Google Sheets URL or spreadsheet ID');
  }

  let id, url;
  if (SHEET_ID.test(raw.trim())) {
    id = raw.trim();
  } else {
    try { url = new URL(raw.trim()); } catch {
      throw new Error('Invalid Google Sheets URL');
    }
    if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' ||
        url.port || url.username || url.password) {
      throw new Error('Only HTTPS Google Sheets links on docs.google.com are allowed');
    }
    const segments = /^\/spreadsheets\/d\/([a-zA-Z0-9_-]{15,150})(?:\/(.*))?$/.exec(url.pathname);
    if (!segments) {
      throw new Error('Expected a Google Sheets /spreadsheets/d/{id} link (published /d/e links are not supported)');
    }
    id = segments[1];
    const endpoint = segments[2] || '';
    if (!['', 'edit', 'view', 'preview', 'copy', 'pubhtml', 'gviz/tq', 'export'].includes(endpoint)) {
      throw new Error('Unrecognized Google Sheets link type');
    }
    if (endpoint === 'export' && url.searchParams.has('format') &&
        url.searchParams.get('format') !== 'csv') {
      throw new Error('Only CSV Google Sheets exports can be normalized');
    }
    if (endpoint === 'gviz/tq') {
      const tqx = url.searchParams.get('tqx') || '';
      if (tqx && !/^out:csv(?:;.*)?$/i.test(tqx)) {
        throw new Error('Only GViz CSV output is supported (tqx=out:csv)');
      }
      if (url.searchParams.has('tq')) {
        throw new Error('GViz query filtering is not supported; provide a sheet tab instead');
      }
    }
  }

  const nameInput = object ? input.name ?? input.label ?? '' : '';
  if (typeof nameInput !== 'string' || nameInput.length > 100) {
    throw new Error('Sheet list name must be at most 100 characters');
  }
  const name = nameInput.trim();
  const explicitGid = object && input.gid !== undefined ? input.gid : undefined;
  const urlGid = url?.searchParams.get('gid') ?? (
    /^#gid=(\d+)$/.exec(url?.hash || '')?.[1] ?? undefined
  );
  const rawGid = explicitGid ?? urlGid;
  const sheetInput = object && input.sheet !== undefined ? input.sheet : (
    url?.searchParams.get('sheet') ?? undefined
  );
  let sheet;
  if (sheetInput !== undefined && sheetInput !== null && sheetInput !== '') {
    if (typeof sheetInput !== 'string' || !sheetInput.trim() || sheetInput.length > 120 ||
        /[\u0000-\u001f\u007f]/.test(sheetInput)) {
      throw new Error('Invalid Google Sheets tab name');
    }
    sheet = sheetInput.trim();
  }
  let gid;
  if (rawGid !== undefined && rawGid !== null && rawGid !== '') {
    const value = String(rawGid);
    if (!/^\d{1,12}$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error('Google Sheets gid must be a non-negative integer');
    }
    gid = String(Number(value));
  } else if (!sheet) {
    gid = '0';
  }

  const base = `https://docs.google.com/spreadsheets/d/${id}`;
  // Keep tqx=out:csv unescaped for exact backward compatibility with the
  // public default URL already used by the existing caller and tests.
  const csvUrl = base + '/gviz/tq?tqx=out:csv&' +
    (gid !== undefined ? 'gid=' + gid : 'sheet=' + encodeURIComponent(sheet));

  const viewUrl = new URL(base + '/edit');
  if (gid !== undefined) viewUrl.searchParams.set('gid', gid);
  // Do not include names or Google account tokens in the request URL.
  return { key: id + ':' + (gid ?? 'sheet:' + sheet), id, gid: gid ?? '',
    sheet: sheet ?? '', name, url: viewUrl.href, csvUrl };
}

export function parseCSV(source) {
  const records = [];
  let row = [], field = '', quoted = false, afterQuote = false;
  const text = String(source || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
    } else if (char === '"' && field === '' && !afterQuote) quoted = true;
    else if (char === '"' || (afterQuote && ![',', '\n', '\r'].includes(char))) {
      throw new Error('Malformed Google Sheets CSV quoting');
    } else if (char === ',') { row.push(field); field = ''; afterQuote = false; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(v => v !== '')) records.push(row);
      row = []; field = ''; afterQuote = false;
    } else field += char;
  }
  if (quoted) throw new Error('Google Sheets CSV ended inside a quoted field');
  row.push(field);
  if (row.some(v => v !== '')) records.push(row);
  return records;
}

function jobLink(text) {
  const value = String(text ?? '').trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return '';
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') &&
        url.hostname && !url.username && !url.password) return url.href;
    if (url.protocol === 'mailto:' && /^[^\s@,;/?#]+@[^\s@,;/?#]+\.[^\s@,;/?#]+$/.test(url.pathname)) {
      return url.href;
    }
    return '';
  } catch {
    return /^[^\s@,;/?#]+@[^\s@,;/?#]+\.[^\s@,;/?#]+$/.test(value) ? 'mailto:' + value : '';
  }
}

// Treat Boolean/formula placeholders in spreadsheet location cells as empty,
// not as a real city, state or country. Other job fields remain untouched.
const cleanLocationCell = value => String(value ?? '').split(',')
  .map(part => part.trim())
  .filter(part => part && !/^(?:false|true|null|undefined)$/i.test(part))
  .join(', ');

function normalizeHeading(value) {
  return String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/')
    .trim().toLowerCase();
}

function columnsFor(header) {
  const headings = header.map(normalizeHeading);
  const locate = matches => headings.findIndex(heading => matches.some(matcher =>
    typeof matcher === 'string' ? heading === matcher : matcher.test(heading)));
  const indexes = {
    studio: locate([/^studio(?:\s*\(.*\))?$/, 'studio name', 'company',
      'company name', 'company/studio', 'studio/company', 'employer', 'employer name',
      'organization', 'organisation', 'firm']),
    title: locate(['job title', 'job', 'title', 'job position', 'job opening',
      'position', 'position title', 'role', 'vacancy']),
    link: locate(['source/contact', 'source', 'contact', 'job url', 'job link',
      'application url', 'application link', 'apply url', 'apply link',
      'posting url', 'job posting url', 'url', 'link', 'career url', 'careers url']),
    location: locate(['location', 'job location', 'work location', 'city/location',
      'city/country', 'location (city, country)']),
    city: locate(['city', 'town']),
    province: locate(['province', 'state', 'province/state', 'state/province',
      'region', 'state/region']),
    country: locate(['country', 'country/region']),
    experience: locate(['experience level', 'seniority level', 'seniority',
      'level', 'experience', 'job level']),
    mode: locate(['remote/hybrid', 'remote / hybrid', 'work mode',
      'working mode', 'workplace type', 'work arrangement', 'remote', 'work type']),
    date: locate(['date', 'date posted', 'posted on', 'posting date',
      'posted', 'added', 'added date', 'listed date', 'date added']),
  };
  if (indexes.studio < 0 || indexes.title < 0 || indexes.link < 0) {
    throw new Error(
      'Public spreadsheet columns have changed; expected Studio/Company, Job Title/Role and Source/Contact/Link'
    );
  }
  return indexes;
}

/**
 * Supports both the original 17-column community list (with blank spacer
 * columns) and straightforward Company, Role, URL, Location, Level CSVs.
 * Conservatively requires real job URLs or application email addresses.
 *
 * Optional {name, id, gid, url} attaches source metadata per returned row
 * without changing the existing zero-argument caller's job shape.
 */
export function parsePublicSheetCSV(csv, metadata = {}) {
  const rows = parseCSV(csv);
  const header = rows.shift() || [];
  const columns = columnsFor(header);
  const jobs = [];
  const seen = new Set();
  for (const row of rows) {
    const get = index => index < 0 ? '' : String(row[index] ?? '').trim();
    const studioName = get(columns.studio);
    const title = get(columns.title);
    const link = jobLink(get(columns.link));
    if (!studioName || !title || !link) continue;
    const rawLocation = cleanLocationCell(get(columns.location));
    const locationParts = rawLocation ? [rawLocation] :
      [columns.city, columns.province, columns.country]
        .map(index => cleanLocationCell(get(index))).filter(Boolean);
    const used = new Set();
    const location = locationParts.filter(part => {
      const normalized = part.toLowerCase();
      if (used.has(normalized)) return false;
      used.add(normalized);
      return true;
    }).join(', ');
    const mode = get(columns.mode);
    const locationWithMode = /^remote$/i.test(mode) ? 'Remote' + (location ? ' · ' + location : '') : location;
    const key = [studioName, title, link, locationWithMode].map(s => s.toLowerCase()).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const sourceDate = get(columns.date);
    const date = Date.parse(sourceDate);
    const job = {
      studioName, title, link, location: locationWithMode,
      experienceLevel: get(columns.experience),
      workMode: mode,
      postedOn: Number.isFinite(date) ? new Date(date).toISOString() : '',
      source: 'Public Google Sheet', proxied: false, extraLink: '',
    };
    if (metadata.name) job.listName = metadata.name;
    if (metadata.id) {
      job.sheetId = metadata.id;
      job.sheetGid = metadata.gid || '';
      job.sheetUrl = metadata.url || '';
    }
    jobs.push(job);
  }
  return jobs.sort((a, b) => (b.postedOn || '').localeCompare(a.postedOn || '') ||
    a.studioName.localeCompare(b.studioName) || a.title.localeCompare(b.title));
}

async function readBoundedCSV(response) {
  const declaredLength = Number(response.headers?.get('content-length') || '0');
  if (declaredLength > MAX_CSV_BYTES) throw new Error('Google Sheets public CSV exceeds 4 MB');
  const contentType = (response.headers?.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    throw new Error('Google Sheets returned a non-CSV page; check public sharing and tab access');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_CSV_BYTES) {
      throw new Error('Google Sheets public CSV exceeds 4 MB');
    }
    return text;
  }
  let byteCount = 0;
  const chunks = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > MAX_CSV_BYTES) throw new Error('Google Sheets public CSV exceeds 4 MB');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Fetch one public list directly from Google. Supports URL strings or objects
 * from parseSheetReference(), plus optional {name,signal,timeoutMs}.
 * Existing fetchPublicSheet() continues to load the bundled default sheet.
 * No request includes user cookies and no data is sent to any proxy.
 */
export async function fetchPublicSheet(reference = PUBLIC_SHEET_URL, options = {}) {
  const normalized = parseSheetReference(reference);
  const named = typeof options.name === 'string' && options.name.trim() ?
    { ...normalized, name: options.name.trim().slice(0, 100) } : normalized;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('Google Sheets request timeout must be between 1 and 120000 ms');
  }
  const incomingSignal = options.signal ||
    (reference && typeof reference === 'object' ? reference.signal : undefined);
  if (incomingSignal !== undefined && (
    typeof incomingSignal?.addEventListener !== 'function' ||
    typeof incomingSignal?.removeEventListener !== 'function'
  )) {
    throw new Error('Google Sheets cancellation signal must be an AbortSignal');
  }
  if (incomingSignal?.aborted) {
    throw new DOMException('Google Sheets request cancelled', 'AbortError');
  }
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  incomingSignal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(named.csvUrl, {
      mode: 'cors', credentials: 'omit', cache: 'no-store',
      redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error('Google Sheets public CSV returned HTTP ' + response.status +
        '; check that this sheet and tab are publicly readable');
    }
    const csv = await readBoundedCSV(response);
    const jobs = parsePublicSheetCSV(csv, named);
    if (!jobs.length) {
      throw new Error('Google Sheets public CSV contained no verifiable application links');
    }
    return jobs;
  } catch (cause) {
    if (timedOut) {
      throw new Error('Google Sheets public CSV request timed out after ' + timeoutMs + ' ms', { cause });
    }
    if (incomingSignal?.aborted) {
      throw new DOMException('Google Sheets request cancelled', 'AbortError');
    }
    if (cause instanceof TypeError) {
      throw new Error('Unable to fetch Google Sheets public CSV (network/CORS or inaccessible sheet)', { cause });
    }
    throw cause;
  } finally {
    clearTimeout(timer);
    incomingSignal?.removeEventListener('abort', cancel);
  }
}
