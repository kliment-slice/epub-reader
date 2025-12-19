import { KokoroTTS } from "./kokoro.js";
import { env } from "./transformers.min.js";
import { splitTextSmart } from "./semantic-split.js";

async function detectWebGPU() {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

const device = await detectWebGPU() ? "webgpu" : "wasm";
self.postMessage({ status: "loading_model_start", device });

let model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";

async function resolveModelId() {
  const onLocalhost = self.location.hostname === "localhost" || self.location.hostname === "127.0.0.1";

  // Prefer local weights during local dev, but fall back to remote if they are missing.
  if (onLocalhost) {
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    env.localModelPath = "/models"; // Our public folder hosts models at /models

    try {
      const res = await fetch("/models/kokoro/onnx/model.onnx", { method: "HEAD" });
      if (res.ok) {
        console.log("Worker: Found local Kokoro weights, using local model path.");
        env.allowRemoteModels = false; // lock to local once found
        return "kokoro";
      }
      console.warn("Worker: Local Kokoro weights not found (status", res.status, "), falling back to remote.");
    } catch (err) {
      console.warn("Worker: Could not verify local Kokoro weights, falling back to remote.", err);
    }
  } else {
    env.allowRemoteModels = true;
  }

  return "onnx-community/Kokoro-82M-v1.0-ONNX";
}

model_id = await resolveModelId();

const tts = await KokoroTTS.from_pretrained(model_id, {
  dtype: device === "wasm" ? "q8" : "fp32", device,
  progress_callback: (progress) => {
    self.postMessage({ status: "loading_model_progress", progress });
  }
}).catch((e) => {
  self.postMessage({ status: "error", error: e.message });
  throw e;
});

self.postMessage({ status: "loading_model_ready", voices: tts.voices, device });

// Track how many buffers are currently in the queue
let bufferQueueSize = 0;
const MAX_QUEUE_SIZE = 6;
let shouldStop = false;
let currentTask = Promise.resolve();

self.addEventListener("message", async (e) => {
  const { type, text, voice, speed } = e.data;
  if (type === "stop") {
    bufferQueueSize = 0;
    shouldStop = true;
    console.log("Stop command received, stopping generation");
    // Wait for any in-flight generation to finish cleanly before accepting new work
    try {
      await currentTask;
    } catch {
      // Swallow errors here; they'll be reported by the generation task
    }
    return;
  }

  if (type === "buffer_processed") {
    bufferQueueSize = Math.max(0, bufferQueueSize - 1);
    return;
  }

  if (text) {
    // Serialize generations to avoid overlapping ONNX sessions
    currentTask = currentTask.then(async () => {
      shouldStop = false;
      let chunks = splitTextSmart(text, 300); // 400 seems to long for kokoro.

      self.postMessage({ status: "chunk_count", count: chunks.length });

      for (const chunk of chunks) {
        if (shouldStop) {
          console.log("Stopping audio generation");
          self.postMessage({ status: "complete" });
          break;
        }
        console.log(chunk);

        while (bufferQueueSize >= MAX_QUEUE_SIZE && !shouldStop) {
          console.log("Waiting for buffer space...");
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (shouldStop) break;
        }

        // If stopped during wait, exit the main loop too
        if (shouldStop) {
          console.log("Stopping after queue wait");
          self.postMessage({ status: "complete" });
          break;
        }

        const audio = await tts.generate(chunk, { voice, speed }); // This is transformers RawAudio
        // If stop was requested during generation, skip emitting audio
        if (shouldStop) {
          console.log("Generation finished after stop; skipping audio emit");
          self.postMessage({ status: "complete" });
          break;
        }

        let ab = audio.audio.buffer;

        bufferQueueSize++;
        self.postMessage({ status: "stream_audio_data", audio: ab, text: chunk }, [ab]);
      }

      // Only send complete if we weren't stopped
      if (!shouldStop) {
        self.postMessage({ status: "complete" });
      }
    }).catch((err) => {
      console.error("Generation failed", err);
      self.postMessage({ status: "error", error: err.message || String(err) });
    });
  }
});
