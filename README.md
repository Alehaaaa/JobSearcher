# JobSearcher

**[Open the live JobSearcher website](https://alehaaaa.github.io/JobSearcher/)**

The complete JobSearcher project now lives in this one repository, with the original histories from `Alehaaaa/JobUI` preserved.

| Branch | Purpose |
| --- | --- |
| [`web-app`](https://github.com/Alehaaaa/JobSearcher/tree/web-app) | Editable React/Vite website, tests, scraper configuration and publishing script |
| [`main`](https://github.com/Alehaaaa/JobSearcher/tree/main) | Python/PySide Maya job browser and studio definitions |
| [`mac`](https://github.com/Alehaaaa/JobSearcher/tree/mac) | Swift/Xcode native macOS application |
| [`github-pages`](https://github.com/Alehaaaa/JobSearcher/tree/github-pages) | **Built static website** served by GitHub Pages; do not develop directly here |

## Website development

```bash
git clone --branch web-app https://github.com/Alehaaaa/JobSearcher.git
cd JobSearcher
npm --prefix web ci
npm --prefix web test
npm --prefix web run build
bash scripts/publish_pages.sh
```

Changes to `web-app` are validated by the `Verify website source` workflow. The published site fetches studio definitions from **this repository's `main` branch**; it no longer depends on `JobUI`.

The former JobUI repository is retained only as a historical backup. New development should go to JobSearcher.
