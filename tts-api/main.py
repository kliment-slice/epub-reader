"""
Kokoro TTS API Server

A FastAPI server that provides text-to-speech using the Kokoro ONNX model.
Designed to be deployed on Fly.io and called from a Cloudflare Pages frontend.
"""

import asyncio
import io
import logging
import os
from contextlib import asynccontextmanager
from typing import Literal

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

# Constrain ONNX Runtime threads so one instance does not starve a shared CPU.
os.environ.setdefault("ORT_INTRA_OP_NUM_THREADS", os.environ.get("TTS_INTRA_OP_THREADS", "1"))
os.environ.setdefault("ORT_INTER_OP_NUM_THREADS", os.environ.get("TTS_INTER_OP_THREADS", "1"))
os.environ.setdefault("OMP_NUM_THREADS", os.environ.get("TTS_OMP_NUM_THREADS", "1"))
os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global model instance
kokoro_instance = None
# Limit concurrent synth jobs per instance to encourage autoscaler to pick up extra load.
MAX_CONCURRENT_SYNTH = max(1, int(os.environ.get("TTS_MAX_CONCURRENCY", "1")))
inference_semaphore = asyncio.Semaphore(MAX_CONCURRENT_SYNTH)

# Available voices (matching the JS implementation)
VOICES = {
    "af_heart": {"name": "Heart", "language": "en-us", "gender": "Female"},
    "af_alloy": {"name": "Alloy", "language": "en-us", "gender": "Female"},
    "af_aoede": {"name": "Aoede", "language": "en-us", "gender": "Female"},
    "af_bella": {"name": "Bella", "language": "en-us", "gender": "Female"},
    "af_jessica": {"name": "Jessica", "language": "en-us", "gender": "Female"},
    "af_kore": {"name": "Kore", "language": "en-us", "gender": "Female"},
    "af_nicole": {"name": "Nicole", "language": "en-us", "gender": "Female"},
    "af_nova": {"name": "Nova", "language": "en-us", "gender": "Female"},
    "af_river": {"name": "River", "language": "en-us", "gender": "Female"},
    "af_sarah": {"name": "Sarah", "language": "en-us", "gender": "Female"},
    "af_sky": {"name": "Sky", "language": "en-us", "gender": "Female"},
    "am_adam": {"name": "Adam", "language": "en-us", "gender": "Male"},
    "am_echo": {"name": "Echo", "language": "en-us", "gender": "Male"},
    "am_eric": {"name": "Eric", "language": "en-us", "gender": "Male"},
    "am_fenrir": {"name": "Fenrir", "language": "en-us", "gender": "Male"},
    "am_liam": {"name": "Liam", "language": "en-us", "gender": "Male"},
    "am_michael": {"name": "Michael", "language": "en-us", "gender": "Male"},
    "am_onyx": {"name": "Onyx", "language": "en-us", "gender": "Male"},
    "am_puck": {"name": "Puck", "language": "en-us", "gender": "Male"},
    "am_santa": {"name": "Santa", "language": "en-us", "gender": "Male"},
    "bf_emma": {"name": "Emma", "language": "en-gb", "gender": "Female"},
    "bf_isabella": {"name": "Isabella", "language": "en-gb", "gender": "Female"},
    "bf_alice": {"name": "Alice", "language": "en-gb", "gender": "Female"},
    "bf_lily": {"name": "Lily", "language": "en-gb", "gender": "Female"},
    "bm_george": {"name": "George", "language": "en-gb", "gender": "Male"},
    "bm_lewis": {"name": "Lewis", "language": "en-gb", "gender": "Male"},
    "bm_daniel": {"name": "Daniel", "language": "en-gb", "gender": "Male"},
    "bm_fable": {"name": "Fable", "language": "en-gb", "gender": "Male"},
}


def split_text_smart(text: str, max_chunk_length: int = 300) -> list[str]:
    """Split text into chunks suitable for TTS, preserving sentence boundaries."""
    import re
    
    paragraph_chunks = re.split(r'\n\s*\n', text)
    final_chunks = []
    
    for para in paragraph_chunks:
        para = para.strip()
        if not para:
            continue
            
        if len(para) <= max_chunk_length:
            final_chunks.append(para)
            continue
        
        # Split on sentence boundaries
        sentence_regex = r'(?<=[.?!])(?=\s+["""\'a-zA-Z])'
        sentences = re.split(sentence_regex, para)
        
        chunk = ''
        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue
                
            if len(sentence) > max_chunk_length:
                # Sentence too long - split on commas or words
                sub_chunks = split_long_sentence(sentence, max_chunk_length)
                for sub in sub_chunks:
                    if len(chunk + ' ' + sub) > max_chunk_length:
                        if chunk:
                            final_chunks.append(chunk.strip())
                        chunk = sub
                    else:
                        chunk = (chunk + ' ' + sub).strip() if chunk else sub
                continue
            
            if len(chunk + ' ' + sentence) > max_chunk_length:
                if chunk:
                    final_chunks.append(chunk.strip())
                chunk = sentence
            else:
                chunk = (chunk + ' ' + sentence).strip() if chunk else sentence
        
        if chunk:
            final_chunks.append(chunk.strip())
    
    return final_chunks


def split_long_sentence(sentence: str, max_len: int) -> list[str]:
    """Split a long sentence on commas or words."""
    chunks = []
    current = ''
    
    comma_parts = sentence.split(', ')
    for part in comma_parts:
        if len(current + ', ' + part) > max_len:
            if current:
                chunks.append(current.strip())
            if len(part) > max_len:
                # Split on words
                words = part.split()
                word_chunk = ''
                for word in words:
                    if len(word_chunk + ' ' + word) > max_len:
                        if word_chunk:
                            chunks.append(word_chunk.strip())
                        word_chunk = word
                    else:
                        word_chunk = (word_chunk + ' ' + word).strip() if word_chunk else word
                if word_chunk:
                    chunks.append(word_chunk.strip())
                current = ''
            else:
                current = part
        else:
            current = (current + ', ' + part).strip(', ') if current else part
    
    if current:
        chunks.append(current.strip())
    
    return chunks


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the Kokoro model on startup."""
    global kokoro_instance
    
    logger.info("Loading Kokoro TTS model...")
    try:
        from kokoro_onnx import Kokoro
        kokoro_instance = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
        logger.info("Kokoro TTS model loaded successfully!")
    except Exception as e:
        logger.error(f"Failed to load Kokoro model: {e}")
        raise
    
    yield
    
    logger.info("Shutting down TTS API...")


async def synthesize_to_wav_bytes(text: str, voice: str, speed: float) -> bytes:
    """Run Kokoro inference off the event loop and return WAV bytes."""
    def _run():
        samples, sample_rate = kokoro_instance.create(
            text,
            voice=voice,
            speed=speed,
        )
        buffer = io.BytesIO()
        sf.write(buffer, samples, sample_rate, format="WAV")
        buffer.seek(0)
        return buffer.read()

    return await asyncio.to_thread(_run)


app = FastAPI(
    title="Kokoro TTS API",
    description="Text-to-Speech API using Kokoro ONNX model",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS configuration - restrict to epub2voice.org only
ALLOWED_ORIGINS = [
    "https://epub2voice.org",
    "https://www.epub2voice.org",
    "http://localhost:3000",  # Local development
    "http://127.0.0.1:3000",  # Local development
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
)


class TTSRequest(BaseModel):
    """Request body for TTS generation."""
    text: str = Field(..., min_length=1, max_length=10000)
    voice: str = Field(default="af_heart")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


class HealthResponse(BaseModel):
    """Health check response."""
    status: Literal["healthy", "loading", "error"]
    model_loaded: bool
    voices: dict | None = None


class VoicesResponse(BaseModel):
    """Available voices response."""
    voices: dict


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Health check endpoint.
    
    Call this on frontend page load to warm up the Fly.io machine
    and ensure the model is ready.
    """
    return HealthResponse(
        status="healthy" if kokoro_instance else "loading",
        model_loaded=kokoro_instance is not None,
        voices=VOICES if kokoro_instance else None,
    )


@app.get("/voices", response_model=VoicesResponse)
async def get_voices():
    """Get available voices."""
    return VoicesResponse(voices=VOICES)


@app.post("/tts")
async def generate_tts(payload: TTSRequest, client_request: Request):
    """
    Generate TTS audio from text.
    
    Returns audio/wav data that can be played directly in the browser.
    """
    if not kokoro_instance:
        raise HTTPException(status_code=503, detail="Model not loaded yet")
    
    if payload.voice not in VOICES:
        raise HTTPException(
            status_code=400, 
            detail=f"Unknown voice: {payload.voice}. Available: {list(VOICES.keys())}"
        )
    
    try:
        async with inference_semaphore:
            audio_bytes = await synthesize_to_wav_bytes(
                payload.text,
                payload.voice,
                payload.speed,
            )

        if await client_request.is_disconnected():
            raise HTTPException(status_code=499, detail="Client disconnected")

        return Response(
            content=audio_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "inline",
                "Cache-Control": "no-cache",
            }
        )
    except Exception as e:
        logger.error(f"TTS generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tts/stream")
async def generate_tts_stream(payload: TTSRequest, client_request: Request):
    """
    Generate TTS audio from text with streaming.
    
    Splits text into chunks and streams audio as each chunk is generated.
    Returns multipart audio chunks that can be played sequentially.
    """
    if not kokoro_instance:
        raise HTTPException(status_code=503, detail="Model not loaded yet")
    
    if payload.voice not in VOICES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown voice: {payload.voice}. Available: {list(VOICES.keys())}"
        )
    
    chunks = split_text_smart(payload.text, max_chunk_length=300)
    
    async def generate():
        for i, chunk in enumerate(chunks):
            if await client_request.is_disconnected():
                logger.info("Client disconnected, stopping stream early")
                break
            try:
                logger.info(f"Generating chunk {i+1}/{len(chunks)}: {chunk[:50]}...")
                
                async with inference_semaphore:
                    wav_bytes = await synthesize_to_wav_bytes(
                        chunk,
                        payload.voice,
                        payload.speed,
                    )
                
                # Yield chunk with metadata header
                # Format: 4 bytes length (big-endian) + text length (2 bytes) + text + wav data
                text_bytes = chunk.encode('utf-8')
                header = len(wav_bytes).to_bytes(4, 'big') + len(text_bytes).to_bytes(2, 'big') + text_bytes
                yield header + wav_bytes
            
            except asyncio.CancelledError:
                logger.info("Streaming cancelled by client")
                break
            
            except Exception as e:
                logger.error(f"Failed to generate chunk {i+1}: {e}")
                # Continue with next chunk instead of failing entirely
                continue
    
    return StreamingResponse(
        generate(),
        media_type="application/octet-stream",
        headers={
            "X-Chunk-Count": str(len(chunks)),
            "Cache-Control": "no-cache",
        }
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
