# ============================================================================
# BUILDER STAGE - Compile Rust binary
# ============================================================================
FROM debian:trixie-slim AS builder

WORKDIR /app

# Layer 1: System dependencies (cached unless Dockerfile changes)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    pkg-config \
    libssl-dev \
    clang \
    espeak-ng \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Layer 2: Install Rust (cached unless Dockerfile changes)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

# Layer 3: Cargo.toml first for dependency caching
# This layer is cached as long as Cargo.toml doesn't change
COPY Cargo.toml Cargo.lock* ./

# Layer 4: Pre-fetch dependencies with dummy main.rs
# This layer caches all cargo dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo fetch && cargo build --release || true && rm -rf src

# Layer 5: Copy actual source code
COPY src ./src
COPY config.json ./config.json

# Layer 6: Build release binary (only rebuilds if src/ or config.json change)
RUN cargo build --release

# Extract ONNX runtime libraries for runtime stage
RUN mkdir -p /app/onnx_libs && \
    find /root/.cargo -name "libonnxruntime.so*" -exec cp {} /app/onnx_libs/ \; 2>/dev/null || true && \
    find target -name "libonnxruntime.so*" -exec cp {} /app/onnx_libs/ \; 2>/dev/null || true

# ============================================================================
# RUNTIME STAGE - Minimal production image
# ============================================================================
FROM debian:trixie-slim AS runner

WORKDIR /app

# Runtime dependencies only (smaller set than builder)
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Copy binary and config from builder
COPY --from=builder /app/target/release/tts-api-rust /usr/local/bin/tts-api-rust
COPY --from=builder /app/config.json /app/config.json
COPY --from=builder /app/onnx_libs/ /usr/lib/

# Copy models if available locally, otherwise download
# This allows local builds to use cached 350MB files while deploys can still work
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
