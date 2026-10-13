import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJobs, loadConfig } from '../scraper.js';
import {
  analyzeJob, countLevels, countLocations, createSearchMatcher,
  LEVELS, matchesLevel, matchesLocation, REGIONS,
} from './filters.js';

const STORAGE_PREFIX = 'jobsearcher.web.v1.';
const AUTO_OPTIONS = [
  [0, 'Never', 'Off'], [10, '10 seconds', '10s'], [30, '30 seconds', '30s'],
  [60, '1 minute', '1m'], [300, '5 minutes', '5m'],
  [600, '10 minutes', '10m'], [3600, '1 hour', '1h'],
];

function readStored(key, fallback) {
  try {
    const value = localStorage.getItem(STORAGE_PREFIX + key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function persist(key, value) {
  try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); }
  catch { /* Browser may disable or exhaust local storage; keep working in memory. */ }
}

function usePreference(key, fallback) {
  const [value, setValue] = useState(() => readStored(key, fallback));
  useEffect(() => { persist(key, value); }, [key, value]);
  return [value, setValue];
}

function validUrl(value, base) {
  if (!value) return null;
  try {
    const url = new URL(value, base || window.location.href);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function careersUrl(studio) {
  const url = studio.website || (Array.isArray(studio.careers_url) ? studio.careers_url[0] : studio.careers_url);
  return validUrl(url);
}

function markSeen(studio, entries, history) {
  const now = Date.now();
  const unique = new Map();
  for (const job of entries) {
    const title = String(job.title || '').trim();
    const link = validUrl(job.link, careersUrl(studio));
    if (!title || !link) continue;
    const dedupe = title.toLowerCase() + '|' + link.toLowerCase();
    if (unique.has(dedupe)) continue;
    const key = JSON.stringify([studio.id, link, title]);
    const previous = history[key];
    const firstSeen = previous?.firstSeen || now;
    history[key] = { firstSeen, lastSeen: now };
    unique.set(dedupe, analyzeJob({
      title, link,
      location: String(job.location || '').trim(),
      extraLink: validUrl(job.extraLink, careersUrl(studio)),
      firstSeen,
    }));
  }
  // Limit growth without losing first-seen dates for positions currently listed.
  const keys = Object.keys(history);
  if (keys.length > 12000) {
    keys.sort((a, b) => history[a].lastSeen - history[b].lastSeen);
    for (const key of keys.slice(0, keys.length - 10000)) delete history[key];
  }
  persist('jobHistory', history);
  return [...unique.values()].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

function errorText(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|networkerror|network request failed|load failed|cors|cross.origin/i.test(message)) {
    return 'Browser request failed. This site may block cross-origin requests (CORS), or the network may be unavailable. ' + message;
  }
  return message || 'Could not retrieve this studio’s jobs.';
}

async function batchFetch(studios, worker, concurrency = 6) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, studios.length) }, async () => {
    while (next < studios.length) {
      const studio = studios[next++];
      await worker(studio);
    }
  }));
}

function Icon({ name, className = '' }) {
  return <svg className={className} aria-hidden="true"><use href={'#i-' + name} /></svg>;
}

function Option({ label, checked, count, onChange, name }) {
  return (
    <label className={'option-row' + (checked ? ' checked' : '')}>
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} name={name} />
      <span className="option-name">{label}</span><span className="option-count">{count || 0}</span>
    </label>
  );
}

function Dropdown({ title, icon, count, open, onToggle, onClear, children, className = '' }) {
  const id = title.toLowerCase() + '-filter-content';
  return (
    <div className={'menu-anchor ' + className}>
      <button type="button" className={'filter-button' + (count ? ' active' : '')}
        onClick={onToggle} aria-expanded={open} aria-controls={id} aria-haspopup="true">
        <Icon name={icon}/><span>{title}</span>{count > 0 && <span className="selected-count">{count}</span>}
        <Icon name="chevron" className="chevron"/>
      </button>
      {open && (
        <div className="popover filter-popover" id={id}>
          <div className="popover-header"><strong>{title === 'Level' ? 'Seniority' : 'Locations'}</strong>
            <button type="button" className="text-button" onClick={onClear}>Clear</button>
          </div>
          <p className="filter-hint">Select any combination of {title === 'Level' ? 'levels' : 'regions and countries'}.</p>
          <div className="filter-scroll">{children}</div>
        </div>
      )}
    </div>
  );
}

function JobAge({ firstSeen }) {
  if (!firstSeen) return null;
  const age = Math.max(0, Date.now() - firstSeen);
  const hours = Math.floor(age / 3600000);
  const label = hours < 1 ? 'New' : hours < 24 ? hours + 'h ago'
    : age < 7 * 86400000 ? Math.floor(age / 86400000) + 'd ago'
    : Math.floor(age / (7 * 86400000)) + 'w ago';
  const ageClass = age < 86400000 ? 'recent' : age < 5 * 86400000 ? 'fresh' : age < 8 * 86400000 ? 'older' : '';
  return <time className={'job-age ' + ageClass} dateTime={new Date(firstSeen).toISOString()}
    title={'First seen ' + new Date(firstSeen).toLocaleString()}>{label}</time>;
}

function StudioCard({ studio, data, jobs, onRefresh, expanded, onExpand }) {
  const career = careersUrl(studio);
  const logo = validUrl(studio.logo_url);
  const [logoFailed, setLogoFailed] = useState(false);
  const limit = expanded ? jobs.length : 35;
  return (
    <section className={'studio-card' + (data?.error ? ' has-error' : '')}
      id={'studio-' + studio.id} aria-label={studio.name}>
      <div className="card-header">
        <div className="studio-brand">
          {career ? (
            <a href={career} target="_blank" rel="noopener noreferrer" className="studio-logo-link" title={'Open ' + studio.name + ' careers'}>
              {logo && !logoFailed ? <img src={logo} alt={studio.name} className="studio-logo" loading="lazy" onError={() => setLogoFailed(true)} />
                : <strong className="logo-fallback">{studio.name}</strong>}
            </a>
          ) : <strong className="logo-fallback">{studio.name}</strong>}
        </div>
        <div className="card-actions">
          {data?.loading ? <span className="mini-spinner" role="status" aria-label={'Loading ' + studio.name} /> : data?.hasFetched && <span className="card-count" title="Matching positions">{jobs.length}</span>}
          <button className="icon-button refresh-studio" type="button" onClick={() => onRefresh(studio)}
            aria-label={'Refresh ' + studio.name} title={'Refresh ' + studio.name} disabled={Boolean(data?.loading)}><Icon name="refresh" /></button>
        </div>
      </div>
      <div className="card-body">
        {data?.error && <div className="card-error" role="alert"><Icon name="warning"/><div><strong>{data.jobs?.length ? 'Refresh failed; showing previous results' : 'Could not load positions'}</strong><p>{data.error}</p></div></div>}
        {!data?.error && Boolean(data?.warnings?.length) && <div className="card-error" role="status"><Icon name="warning"/><div><strong>Some careers endpoints could not be reached</strong>{data.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
        {(!data || (data.loading && !data.hasFetched)) ? (
          <div className="card-placeholder"><span className="mini-spinner"/><span>Checking open positions…</span></div>
        ) : !jobs.length ? (
          <div className="card-placeholder">
            <span>{data.error ? 'Could not retrieve current listings.' : 'No matching positions'}</span>
            <span className="muted small">{data.error ? 'Try refreshing or open the careers page.' : 'Change your filters or check the careers site.'}</span>
            {career && <a href={career} target="_blank" rel="noopener noreferrer" className="subtle-link">Careers page <Icon name="external"/></a>}
          </div>
        ) : (
          <div className="job-list">
            {jobs.slice(0, limit).map(job => (
              <div className="job-item" key={job.link + '|' + job.title}>
                <a className="job-link" href={job.link} target="_blank" rel="noopener noreferrer" title={'View ' + job.title}>
                  <span className="job-title">{job.title}</span>
                  <span className="job-meta">
                    {job.location && <span className="job-location" title={job.location}><Icon name="pin"/>{job.location}</span>}
                    <JobAge firstSeen={job.firstSeen}/>
                  </span>
                  <Icon name="external" className="job-external"/>
                </a>
                {job.extraLink && <a className="job-extra" href={job.extraLink} target="_blank" rel="noopener noreferrer" aria-label={'Additional details for ' + job.title} title="Additional details"><Icon name="document"/></a>}
              </div>
            ))}
            {!expanded && jobs.length > limit && <button type="button" className="show-more" onClick={onExpand}>Show {jobs.length - limit} more positions</button>}
            {expanded && jobs.length > 35 && <button type="button" className="show-more" onClick={onExpand}>Show fewer</button>}
          </div>
        )}
      </div>
      {data?.updatedAt && <div className="card-footer" title={'Last checked ' + new Date(data.updatedAt).toLocaleString()}>Checked {new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>}
    </section>
  );
}

function sortStudios(studios, order) {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...studios].sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
}

export default function App() {
  const [studios, setStudios] = useState([]);
  const [cards, setCards] = useState({});
  const [order, setOrder] = usePreference('studioOrder', []);
  const [disabled, setDisabled] = usePreference('disabledStudios', []);
  const [studioSearch, setStudioSearch] = useState('');
  const [jobSearch, setJobSearch] = usePreference('jobSearch', '');
  const [regions, setRegions] = usePreference('regions', []);
  const [countries, setCountries] = usePreference('countries', []);
  const [levels, setLevels] = usePreference('levels', []);
  const [hideEmpty, setHideEmpty] = usePreference('hideEmpty', true);
  const [autoRefresh, setAutoRefresh] = usePreference('autoRefreshSeconds', 0);
  const [openMenu, setOpenMenu] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expanded, setExpanded] = useState([]);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [configError, setConfigError] = useState('');
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [draggedStudio, setDraggedStudio] = useState(null);
  const historyRef = useRef(null);
  if (historyRef.current === null) historyRef.current = readStored('jobHistory', {});
  const inFlight = useRef(new Set());
  const scheduled = useRef(new Set());
  const allRefreshPromise = useRef(null);
  const refreshAllRef = useRef(null);

  const sortedStudios = useMemo(() => sortStudios(studios, order), [studios, order]);
  const disabledIds = useMemo(() => new Set(disabled), [disabled]);
  const activeStudios = useMemo(() => sortedStudios.filter(studio => !disabledIds.has(studio.id)), [sortedStudios, disabledIds]);
  const matcher = useMemo(() => createSearchMatcher(jobSearch), [jobSearch]);
  const jobMatches = useCallback(job => matcher.test(job) && matchesLocation(job, regions, countries) && matchesLevel(job, levels),
    [matcher, regions, countries, levels]);

  const refreshOne = useCallback(async studio => {
    if (inFlight.current.has(studio.id)) return;
    inFlight.current.add(studio.id);
    setCards(previous => ({ ...previous, [studio.id]: { ...(previous[studio.id] || {}), loading: true } }));
    try {
      const fetched = await fetchJobs(studio);
      if (!Array.isArray(fetched)) throw new Error('The scraper returned an invalid job list.');
      const jobs = markSeen(studio, fetched, historyRef.current);
      const warnings = Array.isArray(fetched.errors) ? fetched.errors.map(errorText) : [];
      setCards(previous => ({ ...previous, [studio.id]: {
        jobs, warnings, loading: false, hasFetched: true, error: null, updatedAt: Date.now(),
      } }));
    } catch (error) {
      setCards(previous => ({ ...previous, [studio.id]: {
        ...(previous[studio.id] || {}), loading: false, hasFetched: true,
        error: errorText(error), updatedAt: Date.now(),
      } }));
    } finally {
      inFlight.current.delete(studio.id);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const items = await loadConfig();
        if (!Array.isArray(items) || !items.length) throw new Error('No studios found in the configuration.');
        if (!cancelled) {
          setStudios(items.filter(item => item && item.id && item.name));
          setConfigError(items.configWarning || '');
        }
      } catch (error) {
        if (!cancelled) setConfigError(errorText(error));
      } finally {
        if (!cancelled) setLoadingConfig(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Queue newly enabled studios once; use bounded browser-side concurrency.
  useEffect(() => {
    const toLoad = activeStudios.filter(studio => !cards[studio.id]?.hasFetched && !scheduled.current.has(studio.id));
    if (!toLoad.length) return;
    toLoad.forEach(studio => scheduled.current.add(studio.id));
    void batchFetch(toLoad, async studio => {
      try { await refreshOne(studio); }
      finally { scheduled.current.delete(studio.id); }
    });
    // Trigger only when the enabled studio set changes, not on each card completion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStudios, refreshOne]);

  const refreshAll = useCallback(async (reloadConfig = true) => {
    if (allRefreshPromise.current) return allRefreshPromise.current;
    const task = (async () => {
      setRefreshingAll(true);
      let current = sortedStudios;
      if (reloadConfig) {
        try {
          const latest = await loadConfig();
          if (!Array.isArray(latest) || !latest.length) throw new Error('The studio configuration was empty.');
          current = sortStudios(latest.filter(item => item && item.id && item.name), order);
          setStudios(current);
          setConfigError(latest.configWarning || '');
        } catch (error) { setConfigError(errorText(error)); }
      }
      await batchFetch(current.filter(studio => !disabledIds.has(studio.id)), refreshOne);
      setRefreshingAll(false);
    })();
    allRefreshPromise.current = task;
    try { await task; } finally { allRefreshPromise.current = null; }
  }, [sortedStudios, order, disabledIds, refreshOne]);

  refreshAllRef.current = refreshAll;
  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshAllRef.current(false);
    }, autoRefresh * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  useEffect(() => {
    if (!openMenu) return undefined;
    const closeOutside = event => {
      if (!(event.target instanceof Element) || !event.target.closest('.menu-anchor')) setOpenMenu('');
    };
    const closeEscape = event => { if (event.key === 'Escape') setOpenMenu(''); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [openMenu]);

  useEffect(() => {
    document.body.classList.toggle('sidebar-open', sidebarOpen);
    return () => document.body.classList.remove('sidebar-open');
  }, [sidebarOpen]);

  const allJobs = useMemo(() => activeStudios.flatMap(studio => cards[studio.id]?.jobs || []), [activeStudios, cards]);
  const shownJobs = useMemo(() => allJobs.filter(jobMatches), [allJobs, jobMatches]);
  const locationCounts = useMemo(() => countLocations(allJobs.filter(job => matcher.test(job) && matchesLevel(job, levels))), [allJobs, matcher, levels]);
  const levelCounts = useMemo(() => countLevels(allJobs.filter(job => matcher.test(job) && matchesLocation(job, regions, countries))), [allJobs, matcher, regions, countries]);
  const availableCountries = useMemo(() => [...new Set([...Object.keys(locationCounts.countries), ...countries])].sort(), [locationCounts, countries]);
  const studioResults = useMemo(() => activeStudios.map(studio => ({
    studio, data: cards[studio.id], jobs: (cards[studio.id]?.jobs || []).filter(jobMatches),
  })), [activeStudios, cards, jobMatches]);
  const visibleResults = studioResults.filter(item => !hideEmpty || item.data?.loading || item.data?.error || !item.data?.hasFetched || item.jobs.length > 0);
  const completedCount = activeStudios.filter(studio => cards[studio.id]?.hasFetched).length;
  const errorCount = activeStudios.filter(studio => cards[studio.id]?.error || cards[studio.id]?.warnings?.length).length;
  const loadingCount = activeStudios.filter(studio => cards[studio.id]?.loading || !cards[studio.id]?.hasFetched).length;
  const hasFilters = Boolean(jobSearch || regions.length || countries.length || levels.length);
  const shownSidebar = sortedStudios.filter(studio => studio.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(studioSearch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()));
  const activeCount = regions.length + countries.length + levels.length;

  function toggleList(setter, value) {
    setter(old => old.includes(value) ? old.filter(item => item !== value) : [...old, value]);
  }
  function clearFilters() { setJobSearch(''); setRegions([]); setCountries([]); setLevels([]); }
  function reorder(sourceId, destinationId) {
    if (!sourceId || !destinationId || sourceId === destinationId) return;
    const ids = sortedStudios.map(studio => studio.id);
    const source = ids.indexOf(sourceId);
    const destination = ids.indexOf(destinationId);
    if (source === -1 || destination === -1) return;
    ids.splice(source, 1);
    ids.splice(destination, 0, sourceId);
    setOrder(ids);
  }
  function moveStudio(id, direction) {
    const ids = sortedStudios.map(studio => studio.id);
    const index = ids.indexOf(id);
    if (index < 0 || index + direction < 0 || index + direction >= ids.length) return;
    const other = ids[index + direction];
    ids[index + direction] = id;
    ids[index] = other;
    setOrder(ids);
  }
  function jumpToStudio(id) {
    setSidebarOpen(false);
    requestAnimationFrame(() => document.getElementById('studio-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  const autoLabel = AUTO_OPTIONS.find(option => option[0] === autoRefresh)?.[2] || autoRefresh + 's';
  const renderChips = [
    ...regions.map(value => ({ kind: 'Region', value, remove: () => toggleList(setRegions, value) })),
    ...countries.map(value => ({ kind: 'Country', value, remove: () => toggleList(setCountries, value) })),
    ...levels.map(value => ({ kind: 'Level', value, remove: () => toggleList(setLevels, value) })),
  ];

  return (
    <div className="app-shell">
      <aside className={'sidebar' + (sidebarOpen ? ' is-open' : '')} aria-label="Studio navigation">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span/><span/><span/></div>
          <div className="brand-type"><div className="brand-name">JobSearcher</div><div className="brand-caption">Studio career browser</div></div>
          <button type="button" className="icon-button mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close studio navigation"><Icon name="x"/></button>
        </div>
        <div className="sidebar-heading"><h2>Studios</h2><span className="muted small">{activeStudios.length}/{studios.length}</span></div>
        <label className="search-field sidebar-search"><Icon name="search"/><input type="search" value={studioSearch} onChange={event => setStudioSearch(event.target.value)} placeholder="Search studios…" aria-label="Search studios"/></label>
        <div className="sidebar-options">
          <button type="button" className="text-button" onClick={() => setDisabled([])}>Enable all</button>
          <button type="button" className="text-button" onClick={() => setDisabled(studios.map(studio => studio.id))}>Disable all</button>
        </div>
        <div className="sidebar-studios" role="list" aria-label="Studios; drag to reorder or use move buttons">
          {shownSidebar.map(studio => {
            const enabled = !disabledIds.has(studio.id);
            const index = sortedStudios.findIndex(item => item.id === studio.id);
            const amount = (cards[studio.id]?.jobs || []).filter(jobMatches).length;
            return <div key={studio.id} role="listitem" className={'sidebar-studio' + (!enabled ? ' disabled' : '') + (draggedStudio === studio.id ? ' dragging' : '')}
              draggable={!studioSearch} onDragStart={event => { setDraggedStudio(studio.id); event.dataTransfer.setData('text/plain', studio.id); event.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => setDraggedStudio(null)} onDragOver={event => { if (!studioSearch) event.preventDefault(); }}
              onDrop={event => { event.preventDefault(); reorder(draggedStudio || event.dataTransfer.getData('text/plain'), studio.id); setDraggedStudio(null); }}>
              <Icon name="drag" className="drag-handle" />
              <input type="checkbox" checked={enabled} aria-label={'Enable ' + studio.name} onChange={() => toggleList(setDisabled, studio.id)} />
              <button className="sidebar-studio-name" type="button" onClick={() => enabled ? jumpToStudio(studio.id) : toggleList(setDisabled, studio.id)} title={studio.name}>{studio.name}</button>
              {enabled && cards[studio.id]?.hasFetched && <span className={'sidebar-job-count' + (cards[studio.id]?.error ? ' error' : '')}>{cards[studio.id]?.error ? '!' : amount}</span>}
              {!studioSearch && <div className="sort-controls">
                <button type="button" className="mini-action" disabled={index === 0} onClick={() => moveStudio(studio.id, -1)} aria-label={'Move ' + studio.name + ' up'}><Icon name="arrow-up"/></button>
                <button type="button" className="mini-action" disabled={index === sortedStudios.length - 1} onClick={() => moveStudio(studio.id, 1)} aria-label={'Move ' + studio.name + ' down'}><Icon name="arrow-down"/></button>
              </div>}
            </div>;
          })}
          {!shownSidebar.length && <p className="sidebar-empty">No studios match.</p>}
        </div>
        <div className="sidebar-footer"><span className={'status-dot' + (errorCount || configError ? ' warning' : loadingCount ? ' loading' : '')}/><span>{loadingConfig ? 'Loading studios…' : loadingCount ? 'Checking ' + loadingCount + ' studios…' : errorCount ? errorCount + ' studios could not be reached' : 'Results fetched on this device'}</span></div>
      </aside>
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close studio navigation"/>}
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-main">
            <button type="button" className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open studio navigation"><Icon name="menu"/></button>
            <div className="page-identity"><h1>Job Browser</h1><p>Animation · VFX · Games</p></div>
            <div className="toolbar-actions">
              <button type="button" className={'toolbar-button' + (hideEmpty ? ' is-selected' : '')} onClick={() => setHideEmpty(value => !value)}
                aria-pressed={hideEmpty} title={hideEmpty ? 'Showing only studios with matching positions or errors' : 'Show all enabled studios'}><Icon name="eye-off"/><span className="hide-on-narrow">Hide empty</span></button>
              <div className="menu-anchor">
                <button type="button" className={'toolbar-button' + (autoRefresh ? ' is-selected' : '')}
                  onClick={() => setOpenMenu(openMenu === 'auto' ? '' : 'auto')}
                  aria-haspopup="true" aria-expanded={openMenu === 'auto'} aria-controls="auto-menu"><Icon name="clock"/><span>{autoLabel}</span><Icon name="chevron" className="chevron"/></button>
                {openMenu === 'auto' && <div className="popover refresh-popover" id="auto-menu">
                  <div className="popover-header"><strong>Auto refresh</strong></div>
                  <div role="radiogroup" aria-label="Automatic refresh interval">
                    {AUTO_OPTIONS.map(([seconds, label]) => <label key={seconds} className={'option-row' + (autoRefresh === seconds ? ' checked' : '')}>
                      <input type="radio" name="auto-refresh" checked={autoRefresh === seconds} onChange={() => { setAutoRefresh(seconds); setOpenMenu(''); }}/>
                      <span className="option-name">{label}</span>
                    </label>)}
                  </div>
                </div>}
              </div>
              <button type="button" className="primary-button" onClick={() => void refreshAll(true)} disabled={refreshingAll || loadingConfig}>
                <Icon name="refresh" className={refreshingAll ? 'spinning' : ''}/><span>Refresh all</span>
              </button>
            </div>
          </div>
          <div className="filterbar">
            <label className="search-field jobs-search"><Icon name="search"/><input type="search" value={jobSearch} onChange={event => setJobSearch(event.target.value)} placeholder="Search jobs or locations (regex supported)" aria-label="Search jobs or locations"/></label>
            <Dropdown title="Location" icon="globe" count={regions.length + countries.length} open={openMenu === 'location'}
              onToggle={() => setOpenMenu(openMenu === 'location' ? '' : 'location')} onClear={() => { setRegions([]); setCountries([]); }}>
              <div className="option-section">Regions & remote</div>
              {REGIONS.map(region => <Option key={region} label={region} checked={regions.includes(region)} count={locationCounts.regions[region]} onChange={() => toggleList(setRegions, region)} name="regions"/>)}
              <div className="option-section">Countries</div>
              {availableCountries.length ? availableCountries.map(country => <Option key={country} label={country} checked={countries.includes(country)} count={locationCounts.countries[country]} onChange={() => toggleList(setCountries, country)} name="countries"/>) : <p className="muted filter-empty">Countries appear once positions load.</p>}
            </Dropdown>
            <Dropdown title="Level" icon="level" count={levels.length} open={openMenu === 'level'}
              onToggle={() => setOpenMenu(openMenu === 'level' ? '' : 'level')} onClear={() => setLevels([])} className="level-menu-anchor">
              {LEVELS.map(level => <Option key={level} label={level} checked={levels.includes(level)} count={levelCounts[level]} onChange={() => toggleList(setLevels, level)} name="levels"/>)}
            </Dropdown>
            {hasFilters && <button type="button" className="text-button clear-all" onClick={clearFilters}>Clear filters</button>}
          </div>
          {renderChips.length > 0 && <div className="active-filters" aria-label="Active filters">
            {renderChips.map(({ kind, value, remove }) => <button className="filter-chip" key={kind + value} type="button" onClick={remove} aria-label={'Remove ' + kind + ' ' + value}>{value}<Icon name="x"/></button>)}
          </div>}
        </header>
        <main className="main-content">
          <div className="results-bar">
            <div className="results-summary"><strong>{shownJobs.length.toLocaleString()} positions</strong><span>{activeStudios.length} enabled studios · {completedCount}/{activeStudios.length} checked</span></div>
            <div className="global-status" role="status" aria-live="polite">
              {matcher.literalFallback && <span className="status-note">Invalid regex · using literal search</span>}
              {loadingCount > 0 && <span className="status-note"><span className="mini-spinner"/>Checking {loadingCount}…</span>}
              {errorCount > 0 && <span className="status-note warning"><Icon name="warning"/>{errorCount} connection {errorCount === 1 ? 'issue' : 'issues'}</span>}
            </div>
          </div>
          {configError && <div className="config-error" role="alert"><Icon name="warning"/><div><strong>{configError.startsWith('Latest GitHub configuration unavailable') ? 'Using bundled studio configuration' : 'Configuration update failed'}</strong><p>{configError}</p></div><button type="button" onClick={() => void refreshAll(true)}>Try again</button></div>}
          {visibleResults.length ? (
            <div className="studio-grid" aria-label="Open positions by studio">
              {visibleResults.map(({ studio, data, jobs }) => <StudioCard key={studio.id} studio={studio} data={data} jobs={jobs} onRefresh={refreshOne}
                expanded={expanded.includes(studio.id)} onExpand={() => toggleList(setExpanded, studio.id)}/>)}
            </div>
          ) : <div className="empty-state">
            <div className="empty-illustration"><Icon name="search"/></div>
            <h2>{loadingConfig ? 'Loading studios…' : !activeStudios.length ? 'No studios enabled' : loadingCount ? 'Checking open positions…' : 'No matching positions'}</h2>
            <p>{!activeStudios.length ? 'Enable one or more studios in the sidebar to browse their jobs.' : loadingCount ? 'Job listings are fetched directly from each studio on this device.' : 'Try adjusting your search, location, seniority or visibility options.'}</p>
            <button type="button" className="secondary-button" onClick={() => { if (!activeStudios.length) setDisabled([]); else if (hasFilters) clearFilters(); else setHideEmpty(false); }}>
              {!activeStudios.length ? 'Enable all studios' : hasFilters ? 'Clear filters' : 'Show all studios'}
            </button>
          </div>}
          <div className="page-footer">Results are loaded live in your browser. Careers sites may restrict cross-origin requests.</div>
        </main>
      </div>
    </div>
  );
}
