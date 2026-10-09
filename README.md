# Sunbury Seminars, Inc.

Official site repo. Register builds one locked Clover total. Submit writes PascalCase rows to `roster-inbox/` in the **private** repo `tomfles1234-star/ssi-roster` via the GitHub Contents API (optional Power Automate forward). No attendee data is ever written to this public repo.

GitHub Pages: Settings → Pages → Deploy from **main**.

Vercel env: `GITHUB_TOKEN` (contents:write and issues:write), optional `ROSTER_REPO` (default `tomfles1234-star/ssi-roster`; the public site repo is refused), `ROSTER_BRANCH` (default `main`). `GITHUB_REPO`/`GITHUB_BRANCH` are no longer used for roster data, optional `POWER_AUTOMATE_URL`, plus Clover keys.

Clover function currently: https://sunbury-seminars-pay-preview.vercel.app/api/create-checkout
Reconnect that Vercel project to this repo before deleting the preview repository.
