## EPUB Reader (Next.js)
[![Cloudflare Pages](https://img.shields.io/endpoint?url=https://YOUR_CLOUDFLARE_WEBHOOK_BADGE_URL)](https://epub-reader-we8.pages.dev)

Kokoro-powered EPUB reader with streaming TTS: upload an EPUB, browse chapters, pick a voice, and listen with word-by-word highlighting.

## Architecture

```
┌─────────────────────────────────────────┐
│     Frontend (Cloudflare Pages)         │
│     Next.js + EPUB.js                   │
│                                         │
│  On load: warmup ping to TTS API        │
│  On play: stream audio from TTS API     │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│      TTS API (Fly.io Container)         │
│      Python FastAPI + Kokoro ONNX       │
│                                         │
│  GET  /health  - Warmup & status        │
│  POST /tts     - Single audio           │
│  POST /tts/stream - Streaming chunks    │
└─────────────────────────────────────────┘
```

## Quick Start

### Frontend (Cloudflare Pages)

```bash
# Install dependencies
npm install

# Set TTS API URL (create .env.local)
echo "NEXT_PUBLIC_TTS_API_URL=http://localhost:8080" > .env.local

# Run dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### TTS API (Fly.io)

```bash
cd tts-api

# Local testing with Docker
docker build -t epub-tts .
docker run -p 8080:8080 epub-tts

# Deploy to Fly.io
fly auth login
fly launch    # First time only
fly deploy
```

## Deployment

### Cloudflare Pages

1. Set environment variable in Cloudflare Pages dashboard:
   - `NEXT_PUBLIC_TTS_API_URL` = `https://your-app.fly.dev`

2. Build settings:
   - Build command: `npx @cloudflare/next-on-pages@1`
   - Output directory: `.vercel/output/static`
   - Compatibility flag: `nodejs_compat`

### Fly.io TTS API

The TTS container auto-stops when idle and auto-starts on request. The frontend warmup ping on page load ensures the model is ready by the time the user clicks Play.

```bash
cd tts-api
fly deploy
```

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `NEXT_PUBLIC_TTS_API_URL` | TTS API server URL | `https://epub-tts.fly.dev` |

## Tech Stack

- **Frontend**: Next.js 16, React 19, EPUB.js, Tailwind CSS
- **Backend**: Python FastAPI, Kokoro ONNX, ONNX Runtime
- **Hosting**: Cloudflare Pages (frontend), Fly.io (TTS API)
