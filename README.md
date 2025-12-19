## EPUB Reader (Next.js)
[![Cloudflare Pages](https://img.shields.io/endpoint?url=https://YOUR_CLOUDFLARE_WEBHOOK_BADGE_URL)](https://epub-reader-we8.pages.dev)

Kokoro-powered EPUB reader with streaming TTS: upload an EPUB, browse chapters, pick a voice, and listen with word-by-word highlighting. Kokoro implementation: https://github.com/rhulha/StreamingKokoroJS

### Deployment status
- Automatic deployments: enabled on Cloudflare Pages

> Badge note: configure a Cloudflare Pages deploy webhook to update the JSON endpoint used in the badge URL above (`YOUR_CLOUDFLARE_WEBHOOK_BADGE_URL`) with a Shields-compatible payload. Example payload:
> ```json
> { "schemaVersion": 1, "label": "Cloudflare Pages", "message": "deploy succeeded", "color": "success" }
> ```

## Getting Started

Install dependencies and run the dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to develop locally.

## Deploying to Cloudflare Pages

Cloudflare Pages supports Next.js via `@cloudflare/next-on-pages`. Typical settings:

- Build command: `npx @cloudflare/next-on-pages@1`
- Output directory: `.vercel/output/static`
- Remember to make the runtime compatibility flag `nodejs_compat` !!!!


Deploy steps (from a terminal with Wrangler auth set up):
```bash
npm install   # install deps (includes dev deps)
npx @cloudflare/next-on-pages build
npx wrangler pages deploy .vercel/output/static
```

If you change Node/Next versions, align them with the `next-on-pages` supported range noted in its README. Cloudflare’s Pages dashboard can also run the same build command and output path for automatic deployments.
