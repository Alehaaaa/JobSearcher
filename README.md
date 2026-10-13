# JobSearcher — browser app source

This branch, **`web-app`**, is the editable Vite/React JobSearcher website source.

- **Live website:** https://alehaaaa.github.io/JobSearcher/
- **Deployment branch:** [`github-pages`](https://github.com/Alehaaaa/JobSearcher/tree/github-pages) (compiled static site, not source)
- **Python/Maya application:** [`main`](https://github.com/Alehaaaa/JobSearcher/tree/main)
- **Native macOS/Xcode application:** [`mac`](https://github.com/Alehaaaa/JobSearcher/tree/mac)

These branches were migrated from JobUI with their **original Git history preserved**. They now live in the same `Alehaaaa/JobSearcher` repository. The original JobUI repository is a backup; do not push new development there.

## Develop and test

```bash
git clone --branch web-app https://github.com/Alehaaaa/JobSearcher.git
cd JobSearcher
npm --prefix web ci
npm --prefix web test
npm --prefix web run build
npm --prefix web run dev
```

Publish after validating a built `web/dist/`:

```bash
bash scripts/publish_pages.sh
```

See [WEB_DEPLOYMENT.md](WEB_DEPLOYMENT.md) for browser CORS, public Google Sheets, source compatibility, live parity checks, and deployment details. The site's browser config is now loaded from `JobSearcher/main/config/studios.json`, not the retired JobUI repository.
