// Run: node --experimental-default-type=module web/test-scraper.mjs
// Dependency-free fixtures for browser scraper logic that does not require DOM.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

console.log(`${passed} scraper checks passed`);
if (process.exitCode) process.exit(1);
