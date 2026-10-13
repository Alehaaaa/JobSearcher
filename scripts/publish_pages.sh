#!/usr/bin/env bash
set -euo pipefail

# Publish the static browser client without changing the macOS application branch.
# GitHub Pages serves the root of the github-pages branch in Alehaaaa/JobSearcher.
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
site_source="${source_root}/web/dist"
target_repo="https://github.com/Alehaaaa/JobSearcher.git"
deployment_dir="$(mktemp -d)"
trap 'rm -rf "${deployment_dir}"' EXIT

if [[ ! -f "${site_source}/index.html" ]]; then
  echo 'Missing Vite build. Run npm --prefix web install && npm --prefix web run build first.' >&2
  exit 1
fi

git -C "${deployment_dir}" init -q
git -C "${deployment_dir}" remote add origin "${target_repo}"
if git -C "${deployment_dir}" fetch -q origin github-pages; then
  git -C "${deployment_dir}" checkout -q -b github-pages FETCH_HEAD
else
  git -C "${deployment_dir}" checkout -q -b github-pages
fi

rsync -a --delete --exclude .git/ "${site_source}/" "${deployment_dir}/"
touch "${deployment_dir}/.nojekyll"
git -C "${deployment_dir}" add -A
if git -C "${deployment_dir}" diff --cached --quiet; then
  echo 'Pages site already matches the local web application.'
  exit 0
fi
git -C "${deployment_dir}" -c user.name='Alehaaaa' -c user.email='alehaaaa@users.noreply.github.com' commit -qm 'Deploy JobSearcher browser application'
git -C "${deployment_dir}" push origin github-pages
echo 'Published to Alehaaaa/JobSearcher branch github-pages.'
