# Kokoro TTS API (Rust draft)

Rust port of the FastAPI TTS server. Uses `axum`, `tokio`, `ort` (ONNX Runtime), and `espeak-ng` for phonemization.

## Status
- Mirrors endpoints: `GET /health`, `GET /voices`, `POST /tts`, `POST /tts/stream`.
- Loads `kokoro-v1.0.onnx` and `voices-v1.0.bin` on startup and warms up once.
- Phonemizes via `espeak-ng --ipa` and maps to the same vocab as the Python version.
- Streams chunks with the same header format (4-byte wav length + 2-byte text length + text + wav data).

## Building locally
```bash
cd tts-api-rust
cargo build
```
You need `espeak-ng` and a reachable ONNX Runtime binary (the `ort` crate will download one by default; set `ORT_DYLIB_PATH` if needed).

## Docker
```bash
docker build -t tts-api-rust -f tts-api-rust/Dockerfile tts-api-rust
docker run -p 8080:8080 tts-api-rust
```

## Config
- `KOKORO_MODEL` (default `kokoro-v1.0.onnx`)
- `KOKORO_VOICES` (default `voices-v1.0.bin`)
- `TTS_MAX_CONCURRENCY` (default 1)
- `PORT` (default 8080)
- Thread caps via `ORT_INTRA_OP_NUM_THREADS`, `ORT_INTER_OP_NUM_THREADS`, `OMP_NUM_THREADS`.

## Gaps / TODO
- Verify phonemization parity vs Python `phonemizer` output (adjust `espeak-ng` flags if needed).
- Confirm ONNX Runtime shared library path in the Docker image; update `LD_LIBRARY_PATH`/copy as needed.
- Add tests for chunk framing and WAV output.
