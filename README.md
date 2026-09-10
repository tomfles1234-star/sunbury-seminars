# Sunbury Seminars, Inc.

Official site repo. Register builds one locked Clover total. Submit writes PascalCase rows to `roster-inbox/` via the GitHub Contents API (optional Power Automate forward).

GitHub Pages: Settings → Pages → Deploy from **main**.

Vercel env: `GITHUB_TOKEN` (contents:write and issues:write), optional `GITHUB_REPO` (default `tomfles1234-star/sunbury-seminars`), `GITHUB_BRANCH` (default `main`), optional `POWER_AUTOMATE_URL`, plus Clover keys.

Clover function currently: https://sunbury-seminars-pay-preview.vercel.app/api/create-checkout
Reconnect that Vercel project to this repo before deleting the preview repository.
