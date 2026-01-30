# EPUB Reader with Local TTS

## 🚀 Live Demo
- **Frontend**: [epub2voice.org](https://epub2voice.org)
- **TTS API**: [https://epub-reader.fly.dev](https://epub-reader.fly.dev)

## Architecture

```
┌─────────────────────────────────────────┐
│     Frontend (Cloudflare Pages)         │
│     Next.js + EPUB.js                   │
│                                         │
│  On load: warmup ping to TTS API        │
│  On play: fetch audio from TTS API      │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│      TTS API (Fly.io Container)         │
│      Rust Axum + Kokoro ONNX            │
│                                         │
│  GET  /health  - Warmup & status        │
│  POST /tts     - Generate audio         │
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
