#!/usr/bin/env bash
# Publishes the viewer to its own origin on Vercel: https://windowcast-viewer.vercel.app
# Not GitHub Pages: every Pages site of an account shares the origin https://kuscher.github.io, and the
# viewer keeps the pairing key in that origin's storage, so any other Pages site could read it.
set -euo pipefail
cd "$(dirname "$0")"
node build.mjs
mkdir -p .vercel-viewer
rsync -a --delete --exclude .vercel dist/viewer/ .vercel-viewer/
cd .vercel-viewer
[ -f .vercel/project.json ] || vercel link --yes --project windowcast-viewer --scope alexkuscher-6326s-projects
vercel deploy --prod --yes --scope alexkuscher-6326s-projects
