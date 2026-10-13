# Live scraper parity audit

Started: 2026-10-13T07:53:15.944Z. Finished: 2026-10-13T07:53:31.679Z.
Configuration and Python scraper: `origin/main` (199015e6b2d922047200954fba9c902152b99bd8).
Node v22.23.3; Python `/Users/aleha/Documents/Programming/GitHub/JobUI/.venv/bin/python`; 6 concurrent studios, independent 25s deadlines.

**Results: match: 70 · empty: 10 · mismatch: 0 · partial_failure: 0 · error: 1 · timeout: 0.** Nonempty matches compare the title, link and location of every listing, including duplicates.

**Limitations:** The JavaScript probe uses jsdom for DOM parsing and Node fetch to compare extraction logic. Node does not enforce browser CORS, so these results do not establish which sites permit live GitHub Pages requests. Both-empty feeds remain unverified and are explicitly classified `empty`. The endpoints are live and may change between the Python and JS requests.

## Individual studio outcomes

| Studio | Strategy | Python | JavaScript | Status |
|---|---|---:|---:|---|
| disney | html | 5 | 5 | match |
| ilm | html | 10 | 10 | match |
| pixar | json | 4 | 4 | match |
| ranchito | html | 0 | 0 | empty |
| dreamworks | json | 10 | 10 | match |
| sonypicturesanimation | html | 4 | 4 | match |
| sonypicturesimageworks | html | 49 | 49 | match |
| blur | html | 2 | 2 | match |
| guerrillagames | html | 0 | 0 | empty |
| dneg | html | 83 | 83 | match |
| illumination | json | 0 | 0 | empty |
| fortiche | html | 1 | 1 | match |
| mikros | json | 1 | 1 | match |
| steamroller | html | 4 | 4 | match |
| giant | html | 0 | 0 | empty |
| netflix | json | 10 | 10 | match |
| iconcreative | json | 28 | 28 | match |
| megalisvfx | json | 4 | 4 | match |
| wildchild | static | 0 | 0 | empty |
| flyingbark | json | 12 | 12 | match |
| rodeofx | json | 39 | 39 | match |
| framestore | html | 10 | 10 | match |
| skydance | json | 11 | 11 | match |
| illusorium | rss | 5 | 5 | match |
| littlezoo | html | 4 | 4 | match |
| twinpines | html | 1 | 1 | match |
| unitimage | html | 8 | 8 | match |
| milkvfx | html | 3 | 3 | match |
| goodbyekansas | html | 1 | 1 | match |
| airshipinteractive | html | 11 | 11 | match |
| ilpvfx | html | 3 | 3 | match |
| thethirdfloor | html | 3 | 3 | match |
| outpostvfx | json | 31 | 31 | match |
| nexusstudios | json | 1 | 1 | match |
| pixomondo | json | 0 | 0 | empty |
| risefx | html | 7 | 7 | match |
| eyeline | json | 0 | 0 | empty |
| luma | html | 1 | 1 | match |
| digitaldomain | html | 73 | 73 | match |
| trixter | html | 1 | 1 | match |
| weta | json_text | 1 | 1 | match |
| titmouse | html | 4 | 4 | match |
| mainframe | json | 1 | 1 | match |
| flyingwildhog | json | 5 | 5 | match |
| brownbag | html | 5 | 5 | match |
| ubisoft | json | 179 | 179 | match |
| cinesite | json | 9 | 9 | match |
| platige | html | 4 | 4 | match |
| riot | html | 157 | 157 | match |
| image-engine | json | 21 | 21 | match |
| oneofus | json | 10 | 10 | match |
| liquiddevelopment | json | 10 | 10 | match |
| threedoubles | rss | 1 | 1 | match |
| lightbox | json | 1 | 1 | match |
| hampa | html | 1 | 1 | match |
| realtimeuk | html | 1 | 1 | match |
| superprod | json_text | 4 | 4 | match |
| atlantis | json_text | 0 | 0 | empty |
| wildbrain | html | 9 | 9 | match |
| buck | json_text | 2 | 2 | match |
| bluezoo | html | 12 | 12 | match |
| squeeze | json_text | 4 | 4 | match |
| zoicstudios | html | 9 | 9 | match |
| mrxfx | html | 0 | 0 | empty |
| craftyapes | json | 16 | error | error |
| kojimaproductions | html | 35 | 35 | match |
| industrialbrothers | html | 1 | 1 | match |
| upp | html | 22 | 22 | match |
| bohemia | remix | 8 | 8 | match |
| pfx | html | 11 | 11 | match |
| warhorse | html | 3 | 3 | match |
| cdprojektred | json | 47 | 47 | match |
| techland | html | 13 | 13 | match |
| pixelzoo | html | 2 | 2 | match |
| atomiccartoons | json | 3 | 3 | match |
| laika | json | 2 | 2 | match |
| bentobox | json | 1 | 1 | match |
| mercuryfilmworks | json | 1 | 1 | match |
| fusefx | json | 74 | 74 | match |
| cartoonsaloon | html | 1 | 1 | match |
| aardman | html | 0 | 0 | empty |

## Exceptions and mismatches

### craftyapes (error)

Python: 16 jobs. JavaScript: error jobs.

JavaScript failure: Studio craftyapes requires a cross-origin CSRF cookie (__Host-next-auth.csrf-token), which a browser cannot read. Use that studio's careers site directly.

javascript warnings:

- {"code":"BROWSER_CSRF_RESTRICTED","message":"Studio craftyapes requires a cross-origin CSRF cookie (__Host-next-auth.csrf-token), which a browser cannot read. Use that studio's careers site directly."}

## Reproduce

From the repository root:

~~~sh
cd web
npm install
node audit-live.mjs --concurrency=6 --timeout=25 --out=./audit-results/latest.json
node audit-live.mjs --studios=ubisoft,luma,industrialbrothers,craftyapes --timeout=25
~~~

Install Python `requests` and `beautifulsoup4` in the selected Python environment; use `--python=/path/to/python` as needed. Use `--ref=<commit SHA>` to pin the main Python/config snapshot and update your local remote ref before auditing current main.

The neighboring JSON contains sampled field differences and per-studio diagnostics; the CSV contains one row per studio.
