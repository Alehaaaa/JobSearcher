// Studio scrapers run entirely inside the visitor's browser on GitHub Pages.
// Each device fetches the live configuration and contacts studio endpoints itself.
const CONFIG_URL = "https://raw.githubusercontent.com/Alehaaaa/JobUI/main/config/studios.json";
const BUNDLED_CONFIG_URL = new URL("./data/studios.json", import.meta.url);
const INVALID_TITLES = new Set(["view job", "details", "read more", "apply", "careers", "unknown"]);
const BLOCKED_HEADERS = new Set([
  "user-agent", "referer", "host", "cookie", "content-length", "origin", "connection",
  "accept-encoding", "access-control-request-headers", "access-control-request-method"
]);

export class StudioFetchError extends Error {
  constructor(message, { code = "SCRAPER_ERROR", url = "", studioId = "", status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StudioFetchError";
    this.code = code;
    this.url = url;
    this.studioId = studioId;
    if (status !== undefined) this.status = status;
  }
}

function cacheBustedURL(input) {
  const url = new URL(input);
  url.searchParams.set("_jobui_cache", String(Date.now()));
  return url;
}

// The web build includes the macOS location fixes. This migrates older main
// configurations only when their location rule is still the known stale rule.
const LOCATION_MIGRATIONS = {
  airshipinteractive: {
    old: { selector: "div.mt-1.text-md span", index: -1 },
    next: { selector: "div.mt-4 span.inline-flex" }
  },
  hampa: {
    old: { selector: "span.text-base span", index: "2" },
    next: { selector: "div.mt-4 span.inline-flex" }
  },
  digitaldomain: {
    old: { selector: "title", split: { sep: ":", index: 1 } },
    next: {
      selector: "title", split: { sep: ":", index: 1 },
      replace: [
        { old: "VC", new: "Vancouver, Canada" },
        { old: "PL", new: "Playa Vista, United States" },
        { old: "MR", new: "Montreal, Canada" }
      ]
    }
  },
  ubisoft: {
    old: "city",
    next: {
      path: "city + ', ' + countryCode",
      replace: Object.entries({
        bg: "Bulgaria", br: "Brazil", ca: "Canada", cn: "China",
        de: "Germany", es: "Spain", fr: "France", gb: "United Kingdom",
        in: "India", ro: "Romania", se: "Sweden", sg: "Singapore",
        ua: "Ukraine", vn: "Vietnam"
      }).map(([old, newValue]) => ({ old: `, ${old}`, new: `, ${newValue}` }))
    }
  },
  pixelzoo: {
    old: { default: "Brisbane, Australia" },
    next: { default: "North Lakes, Brisbane, Australia" }
  }
};

function equalJSON(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left);
  const b = Object.keys(right);
  return a.length === b.length && a.every(k => Object.hasOwn(right, k) && equalJSON(left[k], right[k]));
}

function normalizeStudios(raw) {
  const studios = Array.isArray(raw) ? raw : raw?.studios;
  if (!Array.isArray(studios) || !studios.length) throw new Error("Studio configuration contains no studios");
  return studios.map(studio => {
    if (!studio || typeof studio.id !== "string" || !studio.scraping) {
      throw new Error("Studio configuration includes an invalid studio");
    }
    const fix = LOCATION_MIGRATIONS[studio.id];
    const current = studio.scraping.map?.location;
    if (!fix || !equalJSON(current, fix.old)) return studio;
    return {
      ...studio,
      scraping: { ...studio.scraping, map: { ...studio.scraping.map, location: fix.next } }
    };
  });
}

async function readConfig(url) {
  const response = await fetchWithTimeout(cacheBustedURL(url), { cache: "no-store", mode: "cors" }, 12);
  if (!response.ok) throw new Error(`Configuration returned HTTP ${response.status}`);
  return normalizeStudios(await response.json());
}

/** Fetch current GitHub main/config/studios.json on every invocation, with the
 *  locally bundled copy as an offline/network fallback. */
export async function loadConfig() {
  try {
    return await readConfig(CONFIG_URL);
  } catch (remoteError) {
    try {
      const studios = await readConfig(BUNDLED_CONFIG_URL);
      const warning = `Latest GitHub configuration unavailable; using bundled configuration: ${remoteError.message}`;
      Object.defineProperty(studios, "configWarning", { value: warning, enumerable: false });
      console.warn(warning);
      return studios;
    } catch (localError) {
      throw new StudioFetchError(
        `Unable to load studio configuration from GitHub or this page: ${remoteError.message}; ${localError.message}`,
        { code: "CONFIG_UNAVAILABLE", cause: localError }
      );
    }
  }
}

function stringify(value) {
  if (value == null || (typeof value === "number" && !Number.isFinite(value))) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stringify).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function splitOutsideQuotes(text, char) {
  const result = [];
  let current = "", quote = "", escape = false;
  for (const c of text) {
    if (escape) { current += c; escape = false; continue; }
    if (quote && c === "\\") { current += c; escape = true; continue; }
    if (c === "'" || c === '"') {
      if (!quote) quote = c;
      else if (quote === c) quote = "";
    }
    if (c === char && !quote) { result.push(current.trim()); current = ""; }
    else current += c;
  }
  result.push(current.trim());
  return result.filter(Boolean);
}

// Supports nested keys, [index], [*], comma-separated fallback paths and
// quoted literals in expressions such as city + ', ' + countryCode.
export function extractJSON(root, path = "") {
  if (!path) return root;
  const options = splitOutsideQuotes(path, ",");
  if (options.length > 1) {
    for (const option of options) {
      const value = extractJSON(root, option);
      if (value != null && value !== "" && !(Array.isArray(value) && value.length === 0)) return value;
    }
    return undefined;
  }
  const parts = splitOutsideQuotes(path, "+");
  if (parts.length > 1) {
    const values = [];
    for (const part of parts) {
      if (/^(['"]).*\1$/s.test(part)) {
        values.push(part.slice(1, -1));
      } else {
        const value = extractJSON(root, part);
        if (value == null || value === "") return undefined;
        values.push(stringify(value));
      }
    }
    return values.join("");
  }
  if (/^(['"]).*\1$/s.test(path)) return path.slice(1, -1);
  const segments = path.split(".");
  let nodes = [root];
  let wildcard = false;
  for (const segment of segments) {
    const match = /^([^\[\]]*)(?:\[(-?\d+|\*)\])?$/.exec(segment);
    if (!match) return undefined;
    const [, key, index] = match;
    const next = [];
    for (const node of nodes) {
      const value = key ? node?.[key] : node;
      if (value === undefined || value === null) continue;
      if (index === "*") {
        wildcard = true;
        if (Array.isArray(value)) next.push(...value);
      } else if (index !== undefined) {
        if (Array.isArray(value)) {
          const idx = Number(index);
          const item = value[idx < 0 ? value.length + idx : idx];
          if (item !== undefined) next.push(item);
        }
      } else next.push(value);
    }
    nodes = next;
    if (!nodes.length) break;
  }
  return wildcard ? nodes : (nodes.length === 1 ? nodes[0] : (nodes.length ? nodes : undefined));
}

function applyRule(raw, rule) {
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return stringify(raw);
  if (Object.keys(rule).length === 1 && Object.hasOwn(rule, "default")) return stringify(rule.default);
  let value = Array.isArray(raw)
    ? raw.map(stringify).filter(Boolean).join(rule.join ?? ", ")
    : stringify(raw);
  if (!value) return stringify(rule.default);
  if (rule.split) {
    const fields = value.split(rule.split.sep ?? ":");
    const i = Number(rule.split.index ?? 0);
    value = (fields[i] ?? "").trim();
  }
  if (rule.regex && value) {
    try {
      const match = value.match(new RegExp(rule.regex, "s"));
      value = match ? (match[1] ?? match[0]) : "";
    } catch (error) {
      throw new StudioFetchError(`Invalid mapping regex ${rule.regex}: ${error.message}`, { code: "INVALID_MAPPING", cause: error });
    }
  }
  if (rule.replace && value) {
    const replacements = Array.isArray(rule.replace) ? rule.replace : [rule.replace];
    for (const rep of replacements) {
      if (rep?.old) value = value.split(rep.old).join(rep.new ?? "");
    }
  }
  if (rule.title_case && value) {
    value = value.toLowerCase().replace(/\b(\p{L})/gu, letter => letter.toUpperCase());
  }
  if (value) value = `${rule.prefix ?? ""}${value}${rule.suffix ?? ""}`;
  return value || stringify(rule.default);
}

function jsonValue(item, rule, rootURL) {
  if (rule == null || rule === false) return "";
  const path = typeof rule === "string" ? rule : rule.path;
  const raw = rule?.source === "url" ? rootURL : (path ? extractJSON(item, path) : undefined);
  return applyRule(raw, rule);
}

function decodeMarkup(text) {
  if (typeof document === "undefined") return text.replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, " ")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const template = document.createElement("template");
  template.innerHTML = text;
  return textNodes(template.content);
}

function textNodes(node) {
  if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue ?? "";
  return Array.from(node.childNodes ?? []).map(textNodes).filter(s => s.trim()).join(" ");
}

function cleanText(raw) {
  let text = stringify(raw);
  if (!text) return "";
  if (/<[^>]+>|&(?:\w+|#\d+);/.test(text)) text = decodeMarkup(text);
  return text.replace(/\s+/g, " ").trim().replace(/^[·•|\s\-:]+|[·•|\s\-:]+$/g, "").trim();
}

function removeLocationFromTitle(title, location) {
  if (!title || !location) return title;
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let result = title.replace(new RegExp(escape(location), "gi"), "");
  if (location.includes(",")) {
    for (const part of location.split(",")) {
      const term = part.trim();
      if (term) result = result.replace(new RegExp(`\\b${escape(term)}\\b`, "gi"), "");
    }
  }
  return result.replace(/\s*([\-|/\\·•])\s*([\-|/\\·•]\s*)+/g, " $1 ")
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, "").trim();
}

function safeURL(value, base) {
  if (!value) return "";
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch { return ""; }
}

function finishJob(values, studio, rootURL, mapping) {
  const location = cleanText(values.location);
  let title = cleanText(values.title);
  if (mapping.remove_location_from_title === true || mapping.title?.remove_location_from_title === true) {
    title = cleanText(removeLocationFromTitle(title, location));
  }
  if (!title || INVALID_TITLES.has(title.toLowerCase())) return null;
  const base = safeURL(studio.website) || rootURL;
  const link = safeURL(values.link || rootURL, base);
  if (!link) return null;
  let extraLink = values.extra_link;
  const extraRule = mapping.extra_link;
  if (extraLink && extraRule?.regex_link) {
    try {
      const match = extraLink.match(new RegExp(extraRule.regex_link, "s"));
      extraLink = match ? (match[1] ?? match[0]) : "";
    } catch { extraLink = ""; }
  }
  return { title, link, location, extraLink: safeURL(extraLink, base) };
}

function parseJSONItems(root, studio, url) {
  const config = studio.scraping;
  const map = config.map ?? {};
  let items = extractJSON(root, config.path ?? "");
  if (items == null) return [];
  if (!Array.isArray(items)) items = [items];
  const result = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (config.filter && !stringify(extractJSON(item, config.filter.key)).startsWith(config.filter.startswith)) continue;
    const values = {};
    for (const field of ["title", "link", "location", "extra_link"]) {
      values[field] = jsonValue(item, map[field], url);
    }
    const job = finishJob(values, studio, url, map);
    if (job) result.push(job);
  }
  return result;
}

function selectAll(parent, selector) {
  if (!selector) return [parent];
  return Array.from(parent.querySelectorAll(selector));
}

function selectPrevious(item, selector) {
  let current = item;
  while (current) {
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.matches(selector)) return sibling;
      const descendant = sibling.querySelector(selector);
      if (descendant) return descendant;
      sibling = sibling.previousElementSibling;
    }
    current = current.parentElement;
  }
  return null;
}

function selectNextSibling(item, selector) {
  for (let sibling = item.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
    if (sibling.matches(selector) || sibling.classList.contains(selector)) return sibling;
  }
  return null;
}

function nodeContent(node, attr, exclude) {
  if (!node) return "";
  if (attr === "html") return node.outerHTML || "";
  if (attr !== "text") return node.getAttribute(attr) ?? "";
  if (!exclude) return textNodes(node);
  const clone = node.cloneNode(true);
  clone.querySelectorAll(exclude).forEach(el => el.remove());
  return textNodes(clone);
}

function htmlValue(item, rule, rootURL, defaultAttr = "text") {
  if (rule == null || rule === false) return "";
  const cfg = typeof rule === "string" ? { selector: rule } : rule;
  if (cfg.source === "url") return applyRule(rootURL, cfg);
  if (Object.keys(cfg).length === 1 && Object.hasOwn(cfg, "default")) return stringify(cfg.default);
  let candidates = [];
  if (cfg.find_previous) {
    candidates = [selectPrevious(item, cfg.find_previous)].filter(Boolean);
  } else if (cfg.find_next_sibling) {
    const sibling = selectNextSibling(item, cfg.find_next_sibling);
    candidates = sibling ? selectAll(sibling, cfg.selector ?? "") : [];
  } else {
    candidates = selectAll(item, cfg.selector ?? "");
  }
  const attr = cfg.attr ?? defaultAttr;
  let value = "";
  if (typeof cfg.index === "string" && cfg.index.includes(":")) {
    const [from, until] = cfg.index.split(":");
    const count = candidates.length;
    const boundary = (n, fallback) => n === "" ? fallback : Math.max(0, Math.min(count, Number(n) < 0 ? count + Number(n) : Number(n)));
    value = candidates.slice(boundary(from, 0), boundary(until ?? "", count))
      .map(el => nodeContent(el, attr, cfg.exclude).trim()).filter(Boolean).join(" ");
  } else {
    let index = cfg.index == null ? 0 : Number(cfg.index);
    if (index < 0) index += candidates.length;
    value = nodeContent(candidates[index], attr, cfg.exclude);
  }
  return applyRule(value, cfg);
}

function parseDocument(raw, mime = "text/html") {
  if (typeof DOMParser === "undefined") {
    throw new StudioFetchError("This scraping strategy requires browser DOMParser", { code: "DOM_UNAVAILABLE" });
  }
  const document = new DOMParser().parseFromString(raw, mime);
  if (mime === "application/xml" && document.querySelector("parsererror")) {
    throw new StudioFetchError("Studio returned invalid XML", { code: "INVALID_XML" });
  }
  return document;
}

function parseHTMLItems(text, studio, url, xml = false) {
  const config = studio.scraping;
  const mapping = config.map ?? {};
  const doc = parseDocument(text, xml ? "application/xml" : "text/html");
  const items = selectAll(doc, config.container || (xml ? "item" : ""));
  const jobs = [];
  for (const item of items) {
    const values = {};
    for (const [field, defaultAttr] of Object.entries({
      title: "text", link: "href", location: "text", extra_link: "html"
    })) {
      if (xml) {
        const rule = mapping[field];
        if (rule == null) {
          if (field === "extra_link") { values[field] = ""; continue; }
          const tag = { title: "title", link: "link", location: "description", extra_link: "description" }[field];
          values[field] = item.querySelector(tag)?.textContent ?? (field === "link" ? item.querySelector("guid")?.textContent ?? "" : "");
        } else {
          const cfg = typeof rule === "string" ? { selector: rule } : rule;
          values[field] = Object.keys(cfg).length === 1 && Object.hasOwn(cfg, "default")
            ? stringify(cfg.default)
            : htmlValue(item, { ...cfg, selector: cfg.selector ?? cfg.path ?? (
              field === "title" ? "title" : field === "link" ? "link" : "description"
            ) }, url, "text");
        }
      } else {
        values[field] = htmlValue(item, mapping[field], url, defaultAttr);
      }
    }
    if (!values.title && !xml && config.container?.includes("h2")) {
      values.title = item.textContent ?? "";
    }
    const job = finishJob(values, studio, url, mapping);
    if (job) jobs.push(job);
  }
  return jobs;
}

function decodeDevalue(values) {
  if (!Array.isArray(values)) return values;
  const memo = new Map();
  const decoding = new Set();
  const decode = reference => {
    if (!Number.isInteger(reference)) return reference;
    if (reference < 0 || reference >= values.length) return null;
    if (memo.has(reference)) return memo.get(reference);
    if (decoding.has(reference)) return null;
    decoding.add(reference);
    const value = values[reference];
    let output;
    if (Array.isArray(value)) {
      output = [];
      memo.set(reference, output);
      for (const entry of value) output.push(decode(entry));
    } else if (value && typeof value === "object") {
      output = {};
      memo.set(reference, output);
      for (const [keyReference, entry] of Object.entries(value)) {
        const raw = keyReference.replace(/^_/, "");
        const key = /^\d+$/.test(raw) ? stringify(decode(Number(raw))) : keyReference;
        output[key] = decode(entry);
      }
    } else output = value;
    memo.set(reference, output);
    decoding.delete(reference);
    return output;
  };
  return decode(0);
}

function embeddedJSON(html, studio) {
  const config = studio.scraping;
  const settings = config.json_text ?? {};
  const doc = parseDocument(html);
  const scripts = config.container ? selectAll(doc, config.container) : selectAll(doc, "script");
  const sources = [...scripts.map(el => el.textContent ?? ""), html];
  const regex = settings.regex || null;
  if (regex) {
    for (const source of sources) {
      const match = source.match(new RegExp(regex, "s"));
      if (!match) continue;
      const content = settings.unescape ? decodeMarkup(match[1] ?? match[0]) : match[1] ?? match[0];
      try { return JSON.parse(content); } catch { /* Keep searching other scripts. */ }
    }
  } else {
    const name = settings.variable ?? "jobsData";
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const assignment = new RegExp(`(?:\\b(?:const|let|var)\\s+|window\\.)${escaped}\\s*=\\s*`, "g");
    for (const source of sources) {
      assignment.lastIndex = 0;
      for (let match = assignment.exec(source); match; match = assignment.exec(source)) {
        let start = assignment.lastIndex;
        while (/\s/.test(source[start] ?? "") && start < source.length) start++;
        if (source[start] !== "[" && source[start] !== "{") continue;
        const stack = [], pairs = { "[": "]", "{": "}" };
        let quoted = false, escape = false;
        for (let i = start; i < source.length; i++) {
          const c = source[i];
          if (quoted) {
            if (escape) escape = false;
            else if (c === "\\") escape = true;
            else if (c === '"') quoted = false;
          } else if (c === '"') quoted = true;
          else if (pairs[c]) stack.push(pairs[c]);
          else if (c === "]" || c === "}") {
            if (stack.pop() !== c) break;
            if (!stack.length) {
              try { return JSON.parse(source.slice(start, i + 1)); } catch { break; }
            }
          }
        }
      }
    }
  }
  throw new StudioFetchError(`Could not locate valid embedded JSON in ${studio.name || studio.id}`, {
    code: "INVALID_EMBEDDED_JSON", studioId: studio.id
  });
}

function queryURL(source, params) {
  let url;
  try { url = new URL(source); }
  catch (cause) {
    throw new StudioFetchError(`Invalid careers URL: ${source}`, {
      code: "INVALID_URL", url: stringify(source), cause
    });
  }
  for (const [name, value] of Object.entries(params ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(name, stringify(item));
    } else if (value != null) url.searchParams.append(name, stringify(value));
  }
  return url.href;
}

function requestOptions(config) {
  const method = (config.method || "GET").toUpperCase();
  const headers = new Headers();
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    if (!BLOCKED_HEADERS.has(key.toLowerCase()) && !key.toLowerCase().startsWith("sec-")) {
      headers.set(key, stringify(value));
    }
  }
  const options = { method, headers, mode: "cors", credentials: config.pre_visit ? "include" : "same-origin", cache: "no-store" };
  if (method !== "GET" && method !== "HEAD") {
    if (config.form_data) {
      options.body = new URLSearchParams(Object.entries(config.form_data).map(([k, v]) => [k, stringify(v)]));
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
    } else if (config.payload != null) {
      options.body = JSON.stringify(config.payload);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
  }
  return options;
}

async function makeRequest(url, config, studio) {
  const target = queryURL(url, config.params);
  const options = requestOptions(config);
  if (config.pre_visit?.url) {
    try {
      const preload = await fetchWithTimeout(config.pre_visit.url, { mode: "cors", credentials: "include" });
      if (!preload.ok) throw new Error(`HTTP ${preload.status}`);
    } catch (cause) {
      throw new StudioFetchError(`Pre-visit failed for ${studio.id}: ${cause.message}. Cross-origin access may be blocked by the studio's CORS policy.`, {
        code: "PREVISIT_BLOCKED", url: config.pre_visit.url, studioId: studio.id, cause
      });
    }
    const csrf = config.pre_visit.csrf;
    if (csrf?.cookie && csrf?.header) {
      // Browsers cannot read another domain's cookies, unlike Python/Swift.
      const preVisitOrigin = new URL(config.pre_visit.url).origin;
      if (typeof location === "undefined" || location.origin !== preVisitOrigin) {
        throw new StudioFetchError(`Studio ${studio.id} requires a cross-origin CSRF cookie (${csrf.cookie}), which a browser cannot read. Use that studio's careers site directly.`, {
          code: "BROWSER_CSRF_RESTRICTED", url: config.pre_visit.url, studioId: studio.id
        });
      }
      const cookie = document.cookie.split("; ").find(v => v.startsWith(`${csrf.cookie}=`));
      if (!cookie) throw new StudioFetchError(`CSRF cookie ${csrf.cookie} is not accessible to JavaScript`, {
        code: "BROWSER_CSRF_RESTRICTED", url: config.pre_visit.url, studioId: studio.id
      });
      let value = cookie.slice(csrf.cookie.length + 1);
      if (csrf.unescape) value = decodeURIComponent(value);
      if (csrf.split) value = value.split(csrf.split)[0];
      options.headers.set(csrf.header, value);
    }
  }
  let response;
  try {
    response = await fetchWithTimeout(target, options, config.timeout);
  } catch (cause) {
    if (cause?.code === "TIMEOUT") {
      throw new StudioFetchError(`${studio.name || studio.id}: ${target} timed out`, {
        code: "TIMEOUT", url: target, studioId: studio.id, cause
      });
    }
    throw new StudioFetchError(
      `${studio.name || studio.id}: browser could not fetch ${target}. The studio may block cross-origin requests (CORS), or the network/endpoint may be unavailable; browsers do not disclose which caused a fetch failure.`,
      { code: "CORS_OR_NETWORK", url: target, studioId: studio.id, cause }
    );
  }
  if (!response.ok) {
    throw new StudioFetchError(`${studio.name || studio.id}: ${new URL(target).host} returned HTTP ${response.status}`, {
      code: "HTTP_ERROR", url: target, studioId: studio.id, status: response.status
    });
  }
  return response;
}

async function fetchWithTimeout(url, options, seconds = 20) {
  const controller = new AbortController();
  const ms = Math.max(1000, Number(seconds) * 1000 || 20000);
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new StudioFetchError(`Request exceeded ${ms / 1000} seconds`, {
        code: "TIMEOUT", url, cause
      });
    }
    throw cause;
  } finally { clearTimeout(timer); }
}

async function fetchOne(studio, url) {
  const config = studio.scraping;
  try {
    const response = await makeRequest(url, config, studio);
    switch (config.strategy) {
      case "static": return [];
      case "json": return parseJSONItems(await response.json(), studio, url);
      case "remix": return parseJSONItems(decodeDevalue(await response.json()), studio, url);
      case "json_text": return parseJSONItems(embeddedJSON(await response.text(), studio), studio, url);
      case "html": {
        let html = await response.text();
        if (config.json_html_field) {
          try { html = stringify(extractJSON(JSON.parse(html), config.json_html_field)); }
          catch (cause) {
            throw new StudioFetchError(`Could not extract HTML response field ${config.json_html_field}: ${cause.message}`, {
              code: "INVALID_HTML_JSON", url, studioId: studio.id, cause
            });
          }
        }
        return parseHTMLItems(html, studio, url);
      }
      case "rss": return parseHTMLItems(await response.text(), studio, url, true);
      default: throw new StudioFetchError(`Unsupported scraper strategy ${config.strategy}`, {
        code: "UNSUPPORTED_STRATEGY", url, studioId: studio.id
      });
    }
  } catch (cause) {
    if (cause instanceof StudioFetchError) throw cause;
    throw new StudioFetchError(
      `${studio.name || studio.id}: cannot parse ${config.strategy} response from ${url}: ${cause?.message || cause}`,
      { code: "PARSE_ERROR", url, studioId: studio.id, cause }
    );
  }
}

function dedupeKey(job) {
  const url = new URL(job.link);
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || ["portal", "ref", "source", "jobid"].includes(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  return `${job.title.trim().toLowerCase()}|${url.href.toLowerCase()}`;
}

async function enrichDetails(jobs, studio, errors) {
  const config = studio.scraping.detail_page;
  if (!config?.map || !jobs.length) return jobs;
  const workers = Math.max(1, Math.min(config.max_workers || 6, 12));
  const result = jobs.map(job => ({ ...job }));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const index = cursor++;
      const job = result[index];
      try {
        const response = await makeRequest(job.link, {
          method: "GET", headers: config.headers, timeout: config.timeout ?? 10
        }, studio);
        const doc = parseDocument(await response.text());
        for (const [field, rule] of Object.entries(config.map)) {
          const value = cleanText(htmlValue(doc, rule, job.link));
          if (value && (field === "title" || field === "location")) job[field] = value;
        }
      } catch (error) { errors.push(error); }
    }
  }));
  return result;
}

/** Fetch one studio's live postings in this browser. Output is compatible with
 *  SwiftUI's Job model (title, link, location, extraLink).
 *  Successful endpoints remain visible if another careers URL fails. When
 *  partially successful, the returned array carries a nonenumerable .errors
 *  array with endpoint diagnostics for the UI. */
export async function fetchJobs(studio) {
  if (!studio?.id || !studio.scraping) throw new StudioFetchError("Studio has no scraper configuration", {
    code: "MISSING_SCRAPER", studioId: studio?.id ?? ""
  });
  if (studio.scraping.strategy === "static") return [];
  const urls = (Array.isArray(studio.careers_url) ? studio.careers_url : [studio.careers_url])
    .filter(Boolean);
  if (!urls.length) throw new StudioFetchError(`Studio ${studio.id} has no careers URL`, {
    code: "MISSING_URL", studioId: studio.id
  });
  const results = await Promise.allSettled(urls.map(url => fetchOne(studio, url)));
  const errors = [];
  const jobs = [];
  const seen = new Set();
  for (const result of results) {
    if (result.status === "rejected") { errors.push(result.reason); continue; }
    for (const job of result.value) {
      const key = dedupeKey(job);
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
    }
  }
  if (errors.length === results.length) {
    const error = errors[0];
    if (error && typeof error === "object") {
      error.errors = errors;
      throw error;
    }
    throw new StudioFetchError(`All careers endpoints failed for ${studio.id}`, {
      code: "ALL_ENDPOINTS_FAILED", studioId: studio.id, cause: error
    });
  }
  const enriched = await enrichDetails(jobs, studio, errors);
  Object.defineProperty(enriched, "errors", { value: errors, enumerable: false });
  return enriched;
}
