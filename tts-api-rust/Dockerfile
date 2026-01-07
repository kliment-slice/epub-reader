# Builder - use Debian Trixie (testing) for glibc 2.38+ required by ONNX Runtime
FROM debian:trixie-slim AS builder
WORKDIR /app

# Install Rust toolchain and build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    pkg-config \
    libssl-dev \
    clang \
    espeak-ng \
    ca-certificates \
    wget \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

COPY Cargo.toml .
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo fetch

COPY src ./src
COPY config.json ./config.json
# Build and copy onnxruntime libs - create dir first so COPY never fails
RUN mkdir -p /app/onnx_libs && \
    cargo build --release && \
    find /root/.cargo -name "libonnxruntime.so*" -exec cp {} /app/onnx_libs/ \; 2>/dev/null || true && \
    find target -name "libonnxruntime.so*" -exec cp {} /app/onnx_libs/ \; 2>/dev/null || true && \
    ls -la /app/onnx_libs/ || true && \
    ls -la /app/target/release/tts-api-rust

# Runtime - must use same Debian version for glibc compatibility
FROM debian:trixie-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/tts-api-rust /usr/local/bin/tts-api-rust
COPY --from=builder /app/config.json /app/config.json
# Copy onnxruntime libs if they exist (they may be bundled into the binary)
COPY --from=builder /app/onnx_libs/ /usr/lib/

# Model assets - copy from local cache if present, otherwise download
# Place kokoro-v1.0.onnx and voices-v1.0.bin in models/ dir to skip download
COPY models/ /app/models_cache/
RUN if [ -f /app/models_cache/kokoro-v1.0.onnx ]; then \
    echo "Using cached kokoro-v1.0.onnx"; \
    cp /app/models_cache/kokoro-v1.0.onnx /app/; \
    else \
    echo "Downloading kokoro-v1.0.onnx..."; \
    wget -q https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx; \
    fi && \
    if [ -f /app/models_cache/voices-v1.0.bin ]; then \
    echo "Using cached voices-v1.0.bin"; \
    cp /app/models_cache/voices-v1.0.bin /app/; \
    else \
    echo "Downloading voices-v1.0.bin..."; \
    wget -q https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin; \
    fi && \
    rm -rf /app/models_cache

ENV PORT=8080 LD_LIBRARY_PATH=/usr/lib
EXPOSE 8080
CMD ["tts-api-rust"]
