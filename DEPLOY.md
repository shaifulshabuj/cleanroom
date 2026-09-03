# Deploying Cleanroom

Cleanroom is a static site with no build step. Any static host works; these are the two
fastest paths on Cloudflare.

## Option A — Cloudflare Pages, direct upload (~3 minutes, no CLI)

1. Zip the repo contents (not the folder itself — `index.html` must be at the zip root).
2. Go to **Cloudflare dashboard → Workers & Pages → Create → Pages → Upload assets**.
3. Project name: `cleanroom`. Drag the zip in. Click **Deploy site**.
4. You get `https://cleanroom.pages.dev` (or `https://cleanroom-xxx.pages.dev`).

## Option B — Wrangler CLI (~2 minutes)

```bash
npm install -g wrangler
wrangler login
wrangler pages deploy . --project-name cleanroom
```

## Option C — Connect the GitHub repo

**Workers & Pages → Create → Pages → Connect to Git** → pick the repo.
Build command: *(leave empty)*. Build output directory: `/`.

## After deploying — verify

1. Open the URL in a normal browser. The header should show
   **"No WebMCP host detected"** and **"0 bytes uploaded"**. Click *load the sample dataset*,
   then run a tool in the Agent Console. If that works, the app is fine.
2. Open the same URL in **ChatGPT's browser**. The header should switch to
   **"Agent connected · 14 tools"**.

### If ChatGPT does *not* show "Agent connected"

The most likely culprit is the Content-Security-Policy header. Remove it and redeploy:

```bash
mv _headers _headers.disabled
wrangler pages deploy . --project-name cleanroom
```

The app is functionally identical without it — the CSP is defence-in-depth on top of the
in-page network ledger, not the mechanism itself.
