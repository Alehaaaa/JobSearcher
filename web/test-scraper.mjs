// Run: node --experimental-default-type=module web/test-scraper.mjs
// Dependency-free fixtures for browser scraper logic that does not require DOM.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { extractJSON, fetchJobs, loadConfig } from "./scraper.js";

const nativeFetch = globalThis.fetch;
const studios = JSON.parse(await readFile(new URL("./data/studios.json", import.meta.url), "utf8"));
const studio = id => structuredClone(studios.find(s => s.id === id));
const jsonResponse = body => new Response(JSON.stringify(body), {
  status: 200, headers: { "Content-Type": "application/json" }
});
let passed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${label}`);
  } catch (error) {
    console.error(`✗ ${label}: ${error.stack || error}`);
    process.exitCode = 1;
  } finally { globalThis.fetch = nativeFetch; }
}

await check("nested JSON paths, wildcards, fallbacks, and concatenation", () => {
  const obj = {
    content: [{ name: "Artist" }, { name: "Producer" }],
    location: { city: "London", country: "UK" }
  };
  assert.deepEqual(extractJSON(obj, "content[*].name"), ["Artist", "Producer"]);
  assert.equal(extractJSON(obj, "content[1].name"), "Producer");
  assert.equal(extractJSON(obj, "location.missing, location.city"), "London");
  assert.equal(extractJSON(obj, "location.city + ', ' + location.country"), "London, UK");
  assert.equal(extractJSON(obj, "location.missing + ', ' + location.country, location.city"), "London");
});

await check("fetch latest GitHub JSON on every call", async () => {
  let count = 0;
  globalThis.fetch = async (url, options) => {
    assert.match(url.toString(), /raw\.githubusercontent\.com\/Alehaaaa\/JobUI\/main\/config\/studios\.json/);
    assert.equal(options.cache, "no-store");
    assert.ok(new URL(url).searchParams.has("_jobui_cache"));
    count++;
    return jsonResponse(studios);
  };
  assert.equal((await loadConfig()).length, 81);
  assert.equal((await loadConfig()).length, 81);
  assert.equal(count, 2);
});

await check("fallback bundled config and apply known location migration", async () => {
  const stale = structuredClone(studios);
  stale.find(s => s.id === "ubisoft").scraping.map.location = "city";
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    if (url.toString().includes("raw.githubusercontent.com")) throw new TypeError("Failed to fetch");
    assert.match(url.toString(), /web\/data\/studios\.json/);
    return jsonResponse(stale);
  };
  const oldWarn = console.warn;
  console.warn = () => {};
  try {
    const current = await loadConfig();
    assert.equal(calls, 2);
    assert.match(current.configWarning, /bundled/);
    assert.match(current.find(s => s.id === "ubisoft").scraping.map.location.path, /countryCode/);
  } finally { console.warn = oldWarn; }
});

await check("POST payload and location mappings for Ubisoft", async () => {
  const source = studio("ubisoft");
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, "POST");
    assert.equal(options.headers.get("Content-Type"), "application/json");
    assert.ok(JSON.parse(options.body).requests[0].indexName);
    return jsonResponse({ results: [{ hits: [{
      title: "Senior Animator",
      link: "https://www.ubisoft.com/en-us/game-development/job/senior-animator",
      city: "Montreal", countryCode: "ca"
    }] }] });
  };
  const jobs = await fetchJobs(source);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].location, "Montreal, Canada");
  assert.match(jobs[0].link, /^https?:\/\//);
});

await check("JSON POST form-encoded request", async () => {
  const source = studio("flyingwildhog");
  let verified = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, "POST");
    assert.ok(options.body instanceof URLSearchParams);
    assert.equal(options.body.get("code"), "list");
    verified = true;
    return jsonResponse([]);
  };
  assert.deepEqual(await fetchJobs(source), []);
  assert.ok(verified);
});

await check("deduplicate across endpoints and preserve priority", async () => {
  const source = {
    id: "multi", name: "Multi",
    careers_url: ["https://api.example.test/first", "https://api.example.test/second"],
    scraping: { strategy: "json", path: "results[*]", map: { title: "title", link: "url", location: "city" } }
  };
  globalThis.fetch = async url => jsonResponse({
    results: url.toString().includes("/first") ? [
      { title: "Artist", url: "https://jobs.example.test/artist?utm_source=first", city: "Madrid" },
      { title: "Lead", url: "https://jobs.example.test/lead", city: "Paris" }
    ] : [
      { title: "Artist", url: "https://jobs.example.test/artist?utm_source=second", city: "Tokyo" }
    ]
  });
  const jobs = await fetchJobs(source);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(j => j.location), ["Madrid", "Paris"]);
  assert.equal(jobs.errors.length, 0);
});

await check("preserve successful careers URLs and expose partial failure", async () => {
  const source = {
    id: "mixed", name: "Mixed",
    careers_url: ["https://api.example.test/fail", "https://api.example.test/ok"],
    scraping: { strategy: "json", path: "[*]", map: { title: "title", link: "url" } }
  };
  globalThis.fetch = async url => {
    if (url.toString().includes("/fail")) throw new TypeError("Failed to fetch");
    return jsonResponse([{ title: "Animator", url: "/apply" }]);
  };
  const result = await fetchJobs(source);
  assert.equal(result.length, 1);
  assert.equal(result[0].link, "https://api.example.test/apply");
  assert.equal(result.errors[0].code, "CORS_OR_NETWORK");
});

await check("expose CORS/network errors without pretending to diagnose the browser", async () => {
  const source = studio("eyeline");
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(fetchJobs(source), error => {
    assert.equal(error.code, "CORS_OR_NETWORK");
    assert.match(error.message, /may block cross-origin requests/);
    assert.match(error.message, /network\/endpoint/);
    return true;
  });
});

await check("report HTTP status distinctly from network blocking", async () => {
  const source = studio("eyeline");
  globalThis.fetch = async () => new Response("Forbidden", { status: 403 });
  await assert.rejects(fetchJobs(source), error => {
    assert.equal(error.code, "HTTP_ERROR");
    assert.equal(error.status, 403);
    return true;
  });
});

await check("remix devalue reference decoding", async () => {
  const source = {
    id: "remix-fixture", name: "Remix", careers_url: "https://example.test/jobs",
    scraping: { strategy: "remix", path: "positions[*]", map: {
      title: "title", link: { path: "slug", prefix: "https://example.test/" }, location: "location"
    } }
  };
  globalThis.fetch = async () => jsonResponse([
    { "1": 2 }, "positions", [3], { "4": 5, "6": 7, "8": 9 },
    "title", "Producer", "slug", "producer", "location", "Barcelona"
  ]);
  const jobs = await fetchJobs(source);
  assert.equal(jobs[0].title, "Producer");
  assert.equal(jobs[0].link, "https://example.test/producer");
  assert.equal(jobs[0].location, "Barcelona");
});

await check("static strategy never initiates network traffic", async () => {
  globalThis.fetch = async () => { throw new Error("unexpected network"); };
  const source = { id: "static", careers_url: "https://example.test", scraping: { strategy: "static" } };
  assert.deepEqual(await fetchJobs(source), []);
});

function testStudio(overrides = {}) {
  return {
    id: "proxy-example", name: "Proxy example",
    careers_url: "https://jobs.example.com/openings",
    scraping: { strategy: "json", path: "jobs[*]", map: {
      title: "name", link: "url", location: "location"
    }, ...(overrides.scraping ?? {}) },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "scraping"))
  };
}

await check("GET direct success never contacts a third-party proxy", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.method, "GET");
    return jsonResponse({ jobs: [{ name: "Producer", url: "/apply", location: "London" }] });
  };
  const jobs = await fetchJobs(testStudio());
  assert.equal(jobs.length, 1);
  assert.equal(jobs.proxied, false);
  assert.equal(jobs[0].source, "direct");
  assert.equal(calls.length, 1);
});

await check("failed browser GET uses cors.dev and preserves real target for relative links", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) throw new TypeError("Failed to fetch");
    assert.equal(String(url), "https://proxy.cors.dev/https://jobs.example.com/openings");
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers, undefined);
    return jsonResponse({ jobs: [{ name: "Animator", url: "/apply/345", location: "Remote" }] });
  };
  const jobs = await fetchJobs(testStudio());
  assert.equal(calls.length, 2);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].link, "https://jobs.example.com/apply/345");
  assert.equal(jobs[0].proxied, true);
  assert.equal(jobs[0].source, "cors.dev");
  assert.equal(jobs.proxied, true);
  assert.deepEqual(jobs.sources.map(source => source.source), ["cors.dev"]);
  assert.equal(jobs.errors.length, 0);
});

await check("POST requests never fall back to the free GET-only proxy", async () => {
  const source = testStudio({ scraping: { method: "POST", payload: { searchText: "" } } });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("Failed to fetch"); };
  await assert.rejects(fetchJobs(source), error => error.code === "CORS_OR_NETWORK");
  assert.equal(calls, 1);
});

await check("credentialed headers and CSRF pre-visits must never use public proxies", async () => {
  const headerSource = testStudio({ scraping: { headers: { Authorization: "Bearer SECRET" } } });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("Failed to fetch"); };
  await assert.rejects(fetchJobs(headerSource), error => error.code === "CORS_OR_NETWORK");
  assert.equal(calls, 1);
  calls = 0;
  const csrfSource = testStudio({ scraping: { pre_visit: { url: "https://jobs.example.com/start", csrf: { cookie: "csrftoken", header: "X-CSRF-Token" } } } });
  await assert.rejects(fetchJobs(csrfSource), error => error.code === "PREVISIT_BLOCKED");
  assert.equal(calls, 1);
});

await check("tokens and private/local URLs are ineligible for proxy fallback", async () => {
  const candidates = [
    "https://jobs.example.com/openings?access_token=HIDDEN",
    "https://jobs.example.com/openings?X-Amz-Signature=HIDDEN",
    "https://localhost:8443/openings",
    "https://192.168.1.9/openings",
    "http://jobs.example.com/openings"
  ];
  for (const url of candidates) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new TypeError("Failed to fetch"); };
    await assert.rejects(fetchJobs(testStudio({ careers_url: url })), error => error.code === "CORS_OR_NETWORK");
    assert.equal(calls, 1, "must stay direct-only for " + url);
  }
});

await check("proxy failure preserves direct diagnosis and reports proxy HTTP status", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return new Response("Forbidden", { status: 403 });
  };
  await assert.rejects(fetchJobs(testStudio()), error => {
    assert.equal(error.code, "CORS_OR_NETWORK");
    assert.equal(error.proxyError?.code, "PROXY_HTTP_ERROR");
    assert.match(error.message, /cors.dev fallback also failed/);
    assert.match(error.message, /HTTP 403/);
    return true;
  });
  assert.equal(calls, 2);
});

await check("proxy rejects content over 1 MiB", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return new Response("x".repeat(1_048_577));
  };
  await assert.rejects(fetchJobs(testStudio()), error => error.proxyError?.code === "PROXY_TOO_LARGE");
  assert.equal(calls, 2);
});

await check("mixed endpoints retain successful proxy and direct sources", async () => {
  const source = testStudio({ careers_url: ["https://jobs.example.com/openings", "https://jobs.example.com/more"] });
  globalThis.fetch = async url => {
    if (String(url) === "https://jobs.example.com/openings") throw new TypeError("Failed to fetch");
    if (String(url).includes("proxy.cors.dev")) return jsonResponse({ jobs: [{ name: "Animator", url: "/apply", location: "Paris" }] });
    return jsonResponse({ jobs: [{ name: "Lead", url: "/lead", location: "Berlin" }] });
  };
  const jobs = await fetchJobs(source);
  assert.equal(jobs.length, 2);
  assert.equal(jobs.proxied, true);
  assert.equal(jobs.sources.length, 2);
  assert.deepEqual(jobs.map(job => job.source).sort(), ["cors.dev", "direct"]);
});

await check("Industrial Brothers supports Python (?i) mapping in DOM parsing", async () => {
  const dom = new JSDOM("<!doctype html><p></p>");
  const formerDOM = globalThis.DOMParser;
  const formerDocument = globalThis.document;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.document = dom.window.document;
  try {
    globalThis.fetch = async () => new Response(
      '<article class="job-posting"><a class="text-lg" href="/opening">Background Painter</a><div class="text-xs">HYBRID Toronto, Canada. Full time</div></article>',
      { status: 200, headers: { "Content-Type": "text/html" } }
    );
    const jobs = await fetchJobs(studio("industrialbrothers"));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].location, "Toronto, Canada");
    assert.equal(jobs[0].link, "https://industrialbrothers.applytojobs.ca/opening");
  } finally {
    globalThis.DOMParser = formerDOM;
    globalThis.document = formerDocument;
    dom.window.close();
  }
});

await check("Luma mailto openings survive URL validation; unsafe protocols are blocked", async () => {
  globalThis.fetch = async () => jsonResponse({ jobs: [
    { name: "General Applications", url: "mailto:recruiting@lumapictures.com", location: "Australia" },
    { name: "Unsafe Script", url: "javascript:alert(1)", location: "Unknown" },
    { name: "Unsafe Data", url: "data:text/html,hi", location: "Unknown" },
  ] });
  const jobs = await fetchJobs(testStudio());
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].link, "mailto:recruiting@lumapictures.com");
});

await check("four configured Workable POSTs recover through direct public widget GET", async () => {
  const accounts = [
    ["nexusstudios", "nexusstudios", 1],
    ["pixomondo", "pxo", 0],
    ["oneofus", "one-of-us", 20],
    ["liquiddevelopment", "liquid-development", 15],
  ];
  for (const [studioId, account, count] of accounts) {
    const configured = studio(studioId);
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) {
        assert.equal(String(url), "https://apply.workable.com/api/v3/accounts/" + account + "/jobs");
        assert.equal(options.method, "POST");
        throw new TypeError("Failed to fetch");
      }
      assert.equal(String(url), "https://apply.workable.com/api/v1/widget/accounts/" + account + "?details=true");
      assert.equal(options.method, "GET");
      assert.equal(options.mode, "cors");
      assert.equal(options.credentials, "omit");
      assert.equal(options.headers, undefined);
      return jsonResponse({
        jobs: Array.from({ length: count }, (_, index) => ({
          title: "Workable Position " + index,
          shortcode: "CODE" + index,
          city: "London", country: "United Kingdom",
          locations: [{ city: "London", country: "United Kingdom" }]
        }))
      });
    };
    const jobs = await fetchJobs(configured);
    assert.equal(calls.length, 2, studioId + " used only the direct POST and public GET");
    assert.equal(jobs.length, count);
    assert.equal(jobs.proxied, false);
    assert.equal(jobs.sources[0].source, "Workable public GET");
    assert.equal(jobs.sources[0].requestUrl, "https://apply.workable.com/api/v1/widget/accounts/" + account + "?details=true");
    assert.equal(jobs.errors.length, 0);
    if (count) {
      assert.equal(jobs[0].source, "Workable public GET");
      assert.equal(jobs[0].proxied, false);
      assert.equal(jobs[0].location, "London, United Kingdom");
      assert.equal(jobs[0].link, configured.scraping.map.link.prefix + "CODE0");
    }
  }
});

await check("Workable widget location includes multiple countries without duplicates", async () => {
  const configured = studio("oneofus");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return jsonResponse({ jobs: [{
      title: "Senior Animator", shortcode: "SEN123", city: "London", country: "United Kingdom",
      locations: [
        { city: "London", country: "United Kingdom" },
        { city: "Paris", country: "France" },
        { city: "London", country: "United Kingdom" },
        { city: "Hidden", country: "Spain", hidden: true },
      ]
    }] });
  };
  const jobs = await fetchJobs(configured);
  assert.equal(jobs[0].location, "London, United Kingdom; Paris, France");
  assert.equal(jobs[0].link, "https://apply.workable.com/one-of-us/j/SEN123");
});

await check("Workable same shortcode in different cities remains two postings", async () => {
  const configured = studio("oneofus");
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) throw new TypeError("Failed to fetch");
    return jsonResponse({ jobs: [
      { title: "Lighting TD", shortcode: "SAMECODE", city: "London", country: "United Kingdom" },
      { title: "Lighting TD", shortcode: "SAMECODE", city: "Paris", country: "France" },
      { title: "Lighting TD", shortcode: "SAMECODE", city: "Paris", country: "France" },
    ] });
  };
  const jobs = await fetchJobs(configured);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(job => job.location), ["London, United Kingdom", "Paris, France"]);
  assert.equal(jobs[0].link, jobs[1].link);
  assert.equal(jobs[0].source, "Workable public GET");
});

await check("Workable direct POST success skips widget and retains direct source", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.method, "POST");
    return jsonResponse({ results: [{ title: "Storyboard Artist", shortcode: "DIRECT1",
      location: { display: "Toronto, Canada" } }] });
  };
  const jobs = await fetchJobs(studio("nexusstudios"));
  assert.equal(calls.length, 1);
  assert.equal(jobs[0].source, "direct");
  assert.equal(jobs[0].link, "https://apply.workable.com/nexusstudios/j/DIRECT1");
  assert.equal(jobs[0].location, "Toronto, Canada");
});

await check("Workable POST HTTP errors do not call public widget", async () => {
  for (const status of [400, 403, 429, 500]) {
    let count = 0;
    globalThis.fetch = async () => { count++; return new Response("Error", { status }); };
    await assert.rejects(fetchJobs(studio("nexusstudios")), error => {
      assert.equal(error.code, "HTTP_ERROR");
      assert.equal(error.status, status);
      return true;
    });
    assert.equal(count, 1);
  }
});

await check("widget failure preserves original POST CORS error, with no third-party proxy", async () => {
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch");
    assert.match(String(url), /^https:\/\/apply\.workable\.com\/api\/v1\/widget\//);
    return new Response("Service unavailable", { status: 503 });
  };
  await assert.rejects(fetchJobs(studio("liquiddevelopment")), error => {
    assert.equal(error.code, "CORS_OR_NETWORK");
    assert.equal(error.workableWidgetError?.code, "WORKABLE_WIDGET_HTTP");
    assert.match(error.message, /Workable public GET fallback also failed/);
    return true;
  });
  assert.equal(calls, 2);
});

await check("Workable GET recovery excludes other routes and confidential flows", async () => {
  const original = studio("nexusstudios");
  const candidates = [
    { ...original, careers_url: "https://apply.workable.com/api/v2/accounts/nexusstudios/jobs" },
    { ...original, careers_url: "https://careers.example.com/api/v3/accounts/nexusstudios/jobs" },
    { ...original, scraping: { ...original.scraping, headers: { Authorization: "Bearer PRIVATE" } } },
    { ...original, scraping: { ...original.scraping, pre_visit: { url: "https://example.com/previsit" } } },
  ];
  for (const candidate of candidates) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new TypeError("Failed to fetch"); };
    await assert.rejects(fetchJobs(candidate));
    assert.equal(calls, 1);
  }
});

const PIXAR_DISNEY_CAREERS_URL =
  "https://www.disneycareers.com/en/business/custom_fields.industrycustomfield/pixar%20animation%20studios/391/5";
const PIXAR_PYTHON_TITLES = [
  "On-Call Chef", "Studio Store On-Call Clerk",
  "Staff Systems Engineer, Data Streaming", "Senior Research Scientist"
];
const pixarDisneyHTML = [
  '<!doctype html><html><body>',
  '<a data-job-id="101044147088" href="/en/job/emeryville/studio-store-on-call-clerk/391/101044147088">',
  '<h2>Studio Store On-Call Clerk</h2><span class="job-location">Emeryville,  California</span></a>',
  '<a data-job-id="99545056656" href="/en/job/emeryville/on-call-chef/391/99545056656">',
  '<h2>On-Call Chef</h2><span class="job-location">Emeryville,  California</span></a>',
  '<a data-job-id="97807844336" href="/en/job/emeryville/staff-systems-engineer-data-streaming/391/97807844336">',
  '<h2>Staff Systems Engineer, Data Streaming</h2><span class="job-location">Emeryville,  California</span></a>',
  '<a data-job-id="92888799568" href="/en/job/emeryville/senior-research-scientist/391/92888799568">',
  '<h2>Senior Research Scientist</h2><span class="job-location">Emeryville,  California</span></a>',
  '</body></html>'
].join("");

async function withDOMParser(fn) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const oldDOMParser = globalThis.DOMParser;
  const oldDocument = globalThis.document;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.document = dom.window.document;
  try { return await fn(); } finally {
    globalThis.DOMParser = oldDOMParser;
    globalThis.document = oldDocument;
    dom.window.close();
  }
}

await check("Pixar blocked Workday POST recovers exact Python baseline titles from Disney GET", () => withDOMParser(async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) {
      assert.equal(String(url), studio("pixar").careers_url);
      assert.equal(options.method, "POST");
      assert.equal(options.headers.get("Content-Type"), "application/json");
      throw new TypeError("Failed to fetch");
    }
    assert.equal(String(url), PIXAR_DISNEY_CAREERS_URL);
    assert.equal(options.method, "GET");
    return new Response(pixarDisneyHTML, { status: 200, headers: { "Content-Type": "text/html" } });
  };
  const jobs = await fetchJobs(studio("pixar"));
  assert.equal(requests.length, 2);
  assert.deepEqual(jobs.map(job => job.title).sort(), [...PIXAR_PYTHON_TITLES].sort());
  assert.equal(jobs.length, 4);
  assert.equal(jobs.proxied, false);
  assert.equal(jobs.errors.length, 0);
  assert.deepEqual(jobs.sources, [{
    url: studio("pixar").careers_url, source: "Disney public GET", proxied: false,
    requestUrl: PIXAR_DISNEY_CAREERS_URL
  }]);
  for (const job of jobs) {
    assert.equal(job.source, "Disney public GET");
    assert.equal(job.proxied, false);
    assert.equal(job.location, "Emeryville, California");
    assert.match(job.link, /^https:\/\/www\.disneycareers\.com\/en\/job\/emeryville\/.*\/391\/\d+$/);
  }
}));

await check("Pixar Disney GET retries eligible cors.dev after browser network failure", () => withDOMParser(async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length < 3) throw new TypeError("Failed to fetch");
    assert.equal(String(url), "https://proxy.cors.dev/" + PIXAR_DISNEY_CAREERS_URL);
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers, undefined);
    return new Response(pixarDisneyHTML, { status: 200 });
  };
  const jobs = await fetchJobs(studio("pixar"));
  assert.equal(requests.length, 3);
  assert.equal(jobs.length, 4);
  assert.equal(jobs.proxied, true);
  assert.equal(jobs.sources[0].proxied, true);
  assert.equal(jobs.sources[0].source, "Disney public GET");
  assert.equal(jobs.sources[0].requestUrl, PIXAR_DISNEY_CAREERS_URL);
  assert.ok(jobs.every(job => job.proxied && job.source === "Disney public GET"));
  assert.ok(jobs.every(job => job.link.startsWith("https://www.disneycareers.com/en/job/")));
}));

await check("Pixar successful Workday POST never requests Disney GET", async () => {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), studio("pixar").careers_url);
    assert.equal(options.method, "POST");
    return jsonResponse({ jobPostings: [{
      title: "Animation Engineer",
      externalPath: "https://pixar.wd501.myworkdayjobs.com/Pixar_External_Career_Site/job/Animation",
      locationsText: "Emeryville, California"
    }] });
  };
  const jobs = await fetchJobs(studio("pixar"));
  assert.equal(calls, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source, "direct");
  assert.equal(jobs.proxied, false);
});

await check("Pixar HTTP errors do not activate Disney fallback", async () => {
  for (const status of [400, 403, 429, 500]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("Error", { status }); };
    await assert.rejects(fetchJobs(studio("pixar")), error => {
      assert.equal(error.code, "HTTP_ERROR");
      assert.equal(error.status, status);
      return true;
    });
    assert.equal(calls, 1);
  }
});

await check("Pixar Disney fallback excludes other studios, routes and secret flows", async () => {
  const original = studio("pixar");
  const candidates = [
    { ...original, id: "anotherstudio" },
    { ...original, careers_url: "https://pixar.wd501.myworkdayjobs.com/wday/cxs/pixar/Other/jobs" },
    { ...original, careers_url: original.careers_url + "?access_token=SECRET" },
    { ...original, scraping: { ...original.scraping, method: "GET" } },
    { ...original, scraping: { ...original.scraping, headers: { Authorization: "Bearer PRIVATE" } } }
  ];
  for (const candidate of candidates) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new TypeError("Failed to fetch"); };
    await assert.rejects(fetchJobs(candidate), error => error.code === "CORS_OR_NETWORK");
    assert.equal(calls, 1, "no Pixar fallback expected for " + candidate.id);
  }
});

await check("Pixar Disney fallback failure retains original Workday CORS error", async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    if (requests.length === 1) throw new TypeError("Failed to fetch");
    assert.equal(options.method, "GET");
    return new Response("Unavailable", { status: 503 });
  };
  await assert.rejects(fetchJobs(studio("pixar")), error => {
    assert.equal(error.code, "CORS_OR_NETWORK");
    assert.equal(error.disneyFallbackError?.code, "HTTP_ERROR");
    assert.match(error.message, /Disney public GET fallback also failed/);
    return true;
  });
  assert.deepEqual(requests, [studio("pixar").careers_url, PIXAR_DISNEY_CAREERS_URL]);
});

await check("Pixar public results reject off-Disney links and missing titles", () => withDOMParser(async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) throw new TypeError("Failed to fetch");
    return new Response(pixarDisneyHTML + [
      '<a data-job-id="invalid" href="javascript:alert(1)"><h2>Bad Protocol</h2></a>',
      '<a data-job-id="wrong" href="https://example.com/out"><h2>Wrong Domain</h2></a>',
      '<a data-job-id="no-title" href="/en/job/no-title"></a>'
    ].join(""), { status: 200 });
  };
  const jobs = await fetchJobs(studio("pixar"));
  assert.equal(jobs.length, 4);
}));

console.log(`${passed} scraper checks passed`);
if (process.exitCode) process.exit(1);
