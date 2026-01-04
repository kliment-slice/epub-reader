FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for soundfile and wget
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the Kokoro model files
RUN wget -q https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx \
    && wget -q https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

# Copy application code
COPY . .

EXPOSE 8080

# Use uvicorn with optimal settings for production
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
