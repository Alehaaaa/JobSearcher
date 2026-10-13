# JobSearcher browser app

The Vite/React browser application is in `web/` on the `github-pages` branch of `Alehaaaa/JobUI`. The public site is published from the separate `Alehaaaa/JobSearcher` repository, whose `github-pages` branch contains the contents of the Vite build directory `web/dist/` at its root. Run `npm --prefix web install`, `npm --prefix web run build`, then `bash scripts/publish_pages.sh` after reviewing and committing changes to update that site.

The website downloads the studio definitions from `https://raw.githubusercontent.com/Alehaaaa/JobUI/refs/heads/main/config/studios.json` on each device, with a bundled configuration as fallback. Jobs are fetched directly by JavaScript running in that device's browser. There is no scheduled crawler or remote application server.

Browser security enforces CORS on each external jobs endpoint. Some careers sites do not allow cross-origin requests, or require cookies, custom request headers, or anti-bot challenges. A pure GitHub Pages site cannot override those restrictions. Affected studios display a fetch error with a link to their careers page; their jobs are never silently invented or represented as current.

To run locally, use `npm --prefix web run dev`; to validate deployment, use `npm --prefix web run build` and `npm --prefix web run preview`. File URLs lack consistent fetch support.
