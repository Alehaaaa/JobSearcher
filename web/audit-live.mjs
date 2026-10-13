#!/usr/bin/env node
/**
 * Repeatable live extraction parity audit, one studio per isolated Python and
 * JavaScript subprocess. Both receive IDENTICAL config from a Git ref (default
 * origin/main), and Python scraper sources are materialized directly from that
 * ref. No source/config files are changed.
 *
 * From web/:
 *   npm install
 *   node audit-live.mjs --concurrency=3 --timeout=35 --out=./audit-results/live.json
 *   node audit-live.mjs --studios=ubisoft,outpostvfx --timeout=20
 *
 * Python prerequisites: requests and beautifulsoup4; provide
 * --python=/path/to/venv/bin/python if auto-discovery fails.
 *
 * Node fetch does not enforce browser CORS. A matching record does not imply
 * an endpoint is accessible on GitHub Pages. Empty/errored runs are explicitly
 * distinguished from successful nonempty matches.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(webDir, '..');
const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg !== '--help').map(arg => {
  if (!arg.startsWith('--') || !arg.includes('=')) {
    throw new Error(`Expected --key=value, received: ${arg}`);
  }
  const index = arg.indexOf('=');
  return [arg.slice(2, index), arg.slice(index + 1)];
}));

if (process.argv.includes('--help')) {
  console.log('Usage: node web/audit-live.mjs --studios=a,b --concurrency=3 --timeout=35 --out=web/audit-results/live.json --ref=origin/main --python=/path/bin/python --max-diffs=20');
  process.exit(0);
}

const ref = args.ref || 'origin/main';
const concurrency = boundedNumber(args.concurrency, 3, 1, 12);
const timeoutSeconds = boundedNumber(args.timeout, 35, 3, 300);
const maxDiffs = boundedNumber(args['max-diffs'], 20, 1, 500);
const python = args.python || [
  path.join(repoDir, '.venv', 'bin', 'python'),
  path.join(repoDir, '..', '..', '.venv', 'bin', 'python'),
  'python3',
].find(command => command === 'python3' || existsSync(command));
const outPath = path.resolve(process.cwd(), args.out || 'web/audit-results/latest.json');

function boundedNumber(value, defaultValue, min, max) {
  if (value === undefined || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected integer between ${min} and ${max}; received: ${value}`);
  }
  return parsed;
}

function gitContent(file) {
  return execFileSync('git', ['show', `${ref}:${file}`], {
    cwd: repoDir, encoding: 'utf8', maxBuffer: 25 * 1024 * 1024,
  });
}

// Independently validate local audit dependencies before sending 81 requests.
try {
  await import('jsdom');
} catch {
  console.error('Missing audit-only dependency. In web/, run: npm install');
  console.error('jsdom must be installed as a dev dependency; npm run build does not use it.');
  process.exit(2);
}
const verifyPython = spawn(python, ['-c', 'import requests,bs4'], { stdio: 'ignore' });
const pythonValid = await new Promise(resolve => {
  verifyPython.once('error', () => resolve(false));
  verifyPython.once('close', code => resolve(code === 0));
});
if (!pythonValid) {
  console.error(`Python dependencies missing in ${python}. Install requests and beautifulsoup4 or pass --python=...`);
  process.exit(2);
}

let studios;
try {
  studios = JSON.parse(gitContent('config/studios.json'));
  assert.ok(Array.isArray(studios) && studios.length, 'Main config has no studios');
} catch (error) {
  console.error(`Cannot load exact ${ref} config: ${error.message}`);
  process.exit(2);
}

const only = (args.studios ?? args.studio ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (only.length) {
  const requested = new Set(only);
  studios = studios.filter(item => requested.has(item.id));
  const missing = [...requested].filter(id => !studios.some(s => s.id === id));
  if (missing.length) throw new Error(`Unknown studio IDs in ${ref}: ${missing.join(', ')}`);
}
if (args.strategy) studios = studios.filter(s => s.scraping?.strategy === args.strategy);
if (!studios.length) throw new Error('No studios selected');

const start = new Date().toISOString();
const temp = await mkdtemp(path.join(tmpdir(), 'jobui-parity-'));
const moduleDir = path.join(temp, 'core');
const probeJS = path.join(webDir, 'audit-live-browser.mjs');
const probePython = path.join(webDir, 'audit-live-python.py');
const results = new Array(studios.length);
let next = 0;

try {
  await mkdir(moduleDir);
  for (const file of ['job_scraper.py', 'extractor.py', 'logger.py']) {
    await writeFile(path.join(moduleDir, file), gitContent(`core/${file}`));
  }
  // Original main/core/__init__.py imports unrelated GUI modules. Keep the
  // Python source files identical, but use an empty test package initializer.
  await writeFile(path.join(moduleDir, '__init__.py'), '');

  console.log(`Comparing ${studios.length} studios against ${ref} Python, ${concurrency} concurrent, ${timeoutSeconds}s timeout per implementation.`);
  console.log('Live Node DOM emulation validates extraction; browser CORS remains unverified.');

  await Promise.all(Array.from({ length: Math.min(concurrency, studios.length) }, async () => {
    while (next < studios.length) {
      const index = next++;
      const studio = studios[index];
      const payload = JSON.stringify(studio);
      const [py, js] = await Promise.all([
        runProbe(python, ['-u', probePython, temp], payload, timeoutSeconds),
        runProbe(process.execPath, [probeJS], payload, timeoutSeconds),
      ]);
      const comparison = compare(py, js, maxDiffs);
      results[index] = {
        id: studio.id, name: studio.name, strategy: studio.scraping?.strategy,
        careersUrl: studio.careers_url, status: comparison.status,
        python: {
          ...summarizeProbe(py),
          count: py.ok ? py.jobs.length : null,
        },
        javascript: {
          ...summarizeProbe(js),
          count: js.ok ? js.jobs.length : null,
        },
        differences: comparison.differences,
      };
      const pyCount = py.ok ? py.jobs.length : 'ERR';
      const jsCount = js.ok ? js.jobs.length : 'ERR';
      const num = String(index + 1).padStart(2);
      console.log(`[${num}/${studios.length}] ${studio.id.padEnd(23)} PY ${String(pyCount).padStart(4)} JS ${String(jsCount).padStart(4)}  ${comparison.status}`);
    }
  }));
} finally {
  await rm(temp, { recursive: true, force: true });
}

const statuses = results.reduce((counts, item) => {
  counts[item.status] = (counts[item.status] ?? 0) + 1;
  return counts;
}, {});
const report = {
  meta: {
    auditStartedAt: start,
    auditFinishedAt: new Date().toISOString(),
    gitRef: ref,
    resolvedGitSha: execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: repoDir, encoding: 'utf8',
    }).trim(),
    python,
    node: process.version,
    concurrency,
    timeoutSeconds,
    studioCount: studios.length,
    configSource: `${ref}:config/studios.json`,
    pythonSource: `${ref}:core/job_scraper.py`,
    jsSource: 'web/scraper.js',
    engine: 'Node fetch + jsdom DOMParser',
    limitations: [
      'Node fetch does not enforce CORS; these results cannot establish GitHub Pages availability.',
      'External job postings change in real time; Python and JavaScript request the same feed separately.',
      'Both empty lists without request warnings are marked empty, not as verified positive matches.',
      'The original Python scraper catches some endpoint failures internally; captured ERROR logs are reported as partial_failure.',
    ],
  },
  summary: statuses,
  studios: results,
};
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');
const csvPath = outPath.replace(/\.json$/i, '') + '.csv';
const columns = ['studio', 'strategy', 'status', 'pythonCount', 'jsCount', 'pythonSeconds', 'jsSeconds', 'pythonError', 'jsError', 'missingPython', 'missingJS', 'locationDifferences', 'titleDifferences', 'linkDifferences'];
const csvRows = [columns, ...results.map(s => [
  s.id, s.strategy, s.status, s.python.count ?? '', s.javascript.count ?? '',
  s.python.durationSeconds, s.javascript.durationSeconds,
  s.python.error ?? '', s.javascript.error ?? '',
  s.differences?.pythonOnly?.total ?? 0, s.differences?.javascriptOnly?.total ?? 0,
  s.differences?.locationDifferences?.total ?? 0,
  s.differences?.titleDifferences?.total ?? 0,
  s.differences?.linkDifferences?.total ?? 0,
])];
await writeFile(csvPath, csvRows.map(row => row.map(csvCell).join(',')).join('\n') + '\n');
const mdPath = outPath.replace(/\.json$/i, '') + '.md';
await writeFile(mdPath, markdownReport(report));
console.log('STATUS SUMMARY:', JSON.stringify(statuses));
console.log(`JSON report: ${outPath}`);
console.log(`CSV report:  ${csvPath}`);
console.log(`Markdown:    ${mdPath}`);
if (statuses.mismatch || statuses.error || statuses.timeout || statuses.partial_failure) process.exitCode = 1;

function csvCell(value) {
  const str = String(value ?? '');
  return /[",\r\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
}

function markdownReport(report) {
  const { meta, summary, studios } = report;
  const escapeMD = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const truncate = (text, max = 450) => text.length > max ? text.slice(0, max) + '…' : text;
  const status = ['match', 'empty', 'mismatch', 'partial_failure', 'error', 'timeout']
    .map(label => `${label}: ${summary[label] ?? 0}`).join(' · ');
  const lines = [
    '# Live scraper parity audit',
    '',
    `Started: ${meta.auditStartedAt}. Finished: ${meta.auditFinishedAt}.`,
    `Configuration and Python scraper: \`${meta.gitRef}\` (${meta.resolvedGitSha}).`,
    `Node ${meta.node}; Python \`${meta.python}\`; ${meta.concurrency} concurrent studios, independent ${meta.timeoutSeconds}s deadlines.`,
    '',
    `**Results: ${status}.** Nonempty matches compare the title, link and location of every listing, including duplicates.`,
    '',
    '**Limitations:** The JavaScript probe uses jsdom for DOM parsing and Node fetch to compare extraction logic. Node does not enforce browser CORS, so these results do not establish which sites permit live GitHub Pages requests. Both-empty feeds remain unverified and are explicitly classified \`empty\`. The endpoints are live and may change between the Python and JS requests.',
    '',
    '## Individual studio outcomes',
    '',
    '| Studio | Strategy | Python | JavaScript | Status |',
    '|---|---|---:|---:|---|',
    ...studios.map(item => `| ${escapeMD(item.id)} | ${escapeMD(item.strategy)} | ${item.python.count ?? 'error'} | ${item.javascript.count ?? 'error'} | ${item.status} |`),
    '',
    '## Exceptions and mismatches',
    '',
  ];
  const exceptions = studios.filter(item => !['match', 'empty'].includes(item.status));
  if (!exceptions.length) lines.push('No discrepancies found in this run.');
  for (const item of exceptions) {
    lines.push(`### ${escapeMD(item.id)} (${item.status})`, '');
    lines.push(`Python: ${item.python.count ?? 'error'} jobs. JavaScript: ${item.javascript.count ?? 'error'} jobs.`, '');
    if (item.python.error) lines.push(`Python failure: ${escapeMD(truncate(item.python.error))}`, '');
    if (item.javascript.error) lines.push(`JavaScript failure: ${escapeMD(truncate(item.javascript.error))}`, '');
    for (const field of ['pythonOnly', 'javascriptOnly', 'titleDifferences', 'linkDifferences', 'locationDifferences']) {
      const diff = item.differences?.[field];
      if (!diff?.total) continue;
      lines.push(`${field}: ${diff.total}.`, '', 'Example differences:', '');
      for (const sample of diff.samples.slice(0, 4)) {
        lines.push(`- \`${escapeMD(truncate(JSON.stringify(sample), 550))}\``);
      }
      lines.push('');
    }
    for (const name of ['python', 'javascript']) {
      if (!item[name].warnings?.length) continue;
      lines.push(`${name} warnings:`, '');
      for (const warning of item[name].warnings.slice(0, 5)) {
        lines.push(`- ${escapeMD(truncate(typeof warning === 'string' ? warning : JSON.stringify(warning)))}`);
      }
      lines.push('');
    }
  }
  lines.push('## Reproduce', '', 'From the repository root:', '', '~~~sh',
    'cd web', 'npm install',
    'node audit-live.mjs --concurrency=6 --timeout=25 --out=./audit-results/latest.json',
    'node audit-live.mjs --studios=ubisoft,luma,industrialbrothers,craftyapes --timeout=25',
    '~~~', '',
    'Install Python \`requests\` and \`beautifulsoup4\` in the selected Python environment; use \`--python=/path/to/python\` as needed. Use \`--ref=<commit SHA>\` to pin the main Python/config snapshot and update your local remote ref before auditing current main.',
    '',
    'The neighboring JSON contains sampled field differences and per-studio diagnostics; the CSV contains one row per studio.',
    '');
  return lines.join('\n');
}

function summarizeProbe(probe) {
  return {
    ok: probe.ok,
    timeout: probe.timeout ?? false,
    durationSeconds: probe.durationSeconds,
    warnings: probe.warnings ?? [],
    ...(probe.ok ? {} : { error: probe.error ?? `Exited ${probe.exitCode}` }),
  };
}

function runProbe(binary, argv, stdin, deadlineSeconds) {
  return new Promise(resolve => {
    const started = performance.now();
    let stdout = '', stderr = '', timedOut = false, outputTruncated = false;
    let ended = false;
    const child = spawn(binary, argv, {
      cwd: repoDir, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    const maxOutput = 2 * 1024 * 1024;
    const accumulate = (current, chunk) => {
      if (current.length + chunk.length > maxOutput) {
        outputTruncated = true;
        return (current + chunk).slice(-maxOutput);
      }
      return current + chunk;
    };
    child.stdout.on('data', chunk => { stdout = accumulate(stdout, chunk.toString()); });
    child.stderr.on('data', chunk => { stderr = accumulate(stderr, chunk.toString()); });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, deadlineSeconds * 1000);
    const done = (exitCode, startError) => {
      if (ended) return;
      ended = true;
      clearTimeout(timeout);
      const durationSeconds = Math.round((performance.now() - started) / 10) / 100;
      if (timedOut) return resolve({
        ok: false, timeout: true, durationSeconds,
        error: `Hard process timeout after ${deadlineSeconds}s`, warnings: [],
      });
      const lines = stdout.split(/\r?\n/);
      const result = lines.reverse().find(line => line.startsWith('AUDIT_JSON:'));
      if (result) {
        try {
          const parsed = JSON.parse(result.slice('AUDIT_JSON:'.length));
          return resolve({ ...parsed, durationSeconds, exitCode });
        } catch (error) {
          return resolve({ ok: false, durationSeconds, error: `Invalid probe JSON: ${error.message}`, warnings: [] });
        }
      }
      return resolve({
        ok: false, durationSeconds, exitCode, warnings: [],
        error: `${startError || stderr.slice(-1800) || stdout.slice(-1800) || 'Probe produced no result'}${outputTruncated ? ' (output truncated)' : ''}`,
      });
    };
    child.on('error', error => done(null, error.message));
    child.on('close', code => done(code));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

function fields(job) {
  return {
    title: String(job.title ?? '').trim(),
    link: String(job.link ?? '').trim(),
    location: String(job.location ?? '').trim(),
  };
}

function compare(py, js, maxItems) {
  if (py.timeout || js.timeout) return { status: 'timeout' };
  if (!py.ok || !js.ok) return { status: 'error' };
  const left = py.jobs.map(fields);
  const right = js.jobs.map(fields);
  const all = (rows, key) => {
    const map = new Map();
    for (const row of rows) {
      const k = JSON.stringify(key.map(field => row[field]));
      const group = map.get(k) ?? [];
      group.push(row);
      map.set(k, group);
    }
    return map;
  };
  const leftFull = all(left, ['title', 'link', 'location']);
  const rightFull = all(right, ['title', 'link', 'location']);
  const only = (a, b) => {
    const result = [];
    for (const [key, rows] of a) {
      const matched = b.get(key)?.length ?? 0;
      if (rows.length > matched) result.push(...rows.slice(matched));
    }
    return { total: result.length, samples: result.slice(0, maxItems) };
  };
  const pythonOnly = only(leftFull, rightFull);
  const javascriptOnly = only(rightFull, leftFull);
  const fieldChanges = (field, sharedFields) => {
    const l = all(left, sharedFields);
    const r = all(right, sharedFields);
    const items = [];
    for (const [key, a] of l) {
      const b = r.get(key);
      if (!b) continue;
      const av = a.map(j => j[field]).sort();
      const bv = b.map(j => j[field]).sort();
      if (JSON.stringify(av) !== JSON.stringify(bv)) items.push({
        match: JSON.parse(key),
        python: av.slice(0, 6),
        javascript: bv.slice(0, 6),
      });
    }
    return { total: items.length, samples: items.slice(0, maxItems) };
  };
  const differences = {
    pythonOnly, javascriptOnly,
    titleDifferences: fieldChanges('title', ['link']),
    linkDifferences: fieldChanges('link', ['title']),
    locationDifferences: fieldChanges('location', ['title', 'link']),
  };
  let status = pythonOnly.total || javascriptOnly.total ? 'mismatch'
    : left.length === 0 && right.length === 0 ? 'empty' : 'match';
  if ((py.warnings?.length || js.warnings?.length) && (status === 'match' || status === 'empty')) {
    status = 'partial_failure';
  }
  return { status, differences };
}
