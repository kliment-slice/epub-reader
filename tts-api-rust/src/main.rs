use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use hound::{SampleFormat, WavSpec, WavWriter};
use ndarray::{s, Array3};
use ndarray_npy::NpzReader;
use once_cell::sync::Lazy;
use ort::execution_providers::CPUExecutionProvider;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Value;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio_stream::StreamExt;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

const DEFAULT_MODEL_PATH: &str = "kokoro-v1.0.onnx";
const DEFAULT_VOICES_PATH: &str = "voices-v1.0.bin";
const MAX_PHONEME_LENGTH: usize = 510;
const SAMPLE_RATE: u32 = 24_000;
const MAX_CONCURRENCY: usize = 1;

static VOCAB: Lazy<HashMap<char, i64>> = Lazy::new(|| load_vocab().expect("load vocab"));

#[derive(Clone)]
struct VoiceTable {
    styles: Vec<Vec<f32>>, // index by token length
}

impl VoiceTable {
    fn style_for_len(&self, len: usize) -> &[f32] {
        let idx = len.min(self.styles.len().saturating_sub(1));
        &self.styles[idx]
    }
}

#[derive(Clone)]
struct AppState {
    session: Arc<tokio::sync::Mutex<Session>>,
    voices: Arc<HashMap<String, VoiceTable>>,
    semaphore: Arc<Semaphore>,
}

#[derive(Deserialize)]
struct TtsRequest {
    text: String,
    voice: Option<String>,
    speed: Option<f32>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    model_loaded: bool,
    voices: Option<HashMap<String, VoiceMeta>>,
}

#[derive(Serialize)]
struct VoiceMeta {
    name: String,
    language: String,
    gender: String,
}

#[derive(Serialize)]
struct VoicesResponse {
    voices: HashMap<String, VoiceMeta>,
}

#[derive(thiserror::Error, Debug)]
enum ApiError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let body = serde_json::json!({ "error": self.to_string() });
        (status, Json(body)).into_response()
    }
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        // Ensure errors are visible even if tracing is misconfigured.
        eprintln!("fatal: {err}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), ApiError> {
    eprintln!("[TTS] Starting up...");
    init_tracing();
    let model_path = std::env::var("KOKORO_MODEL").unwrap_or_else(|_| DEFAULT_MODEL_PATH.to_string());
    let voices_path = std::env::var("KOKORO_VOICES").unwrap_or_else(|_| DEFAULT_VOICES_PATH.to_string());
    eprintln!("[TTS] Model path: {model_path}");
    eprintln!("[TTS] Voices path: {voices_path}");

    eprintln!("[TTS] Loading model...");
    let session = load_model(&model_path)?;
    eprintln!("[TTS] Model loaded");
    
    eprintln!("[TTS] Loading voices...");
    let voices = Arc::new(load_voices(&voices_path)?);
    let semaphore = Arc::new(Semaphore::new(
        std::env::var("TTS_MAX_CONCURRENCY")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|v| *v > 0)
            .unwrap_or(MAX_CONCURRENCY),
    ));
    eprintln!("[TTS] Voices loaded");

    let state = AppState {
        session: Arc::new(tokio::sync::Mutex::new(session)),
        voices,
        semaphore,
    };

    // Spawn warmup in background so server starts immediately
    let warmup_state = state.clone();
    tokio::spawn(async move {
        eprintln!("[TTS] Starting warmup...");
        warmup(&warmup_state).await;
        eprintln!("[TTS] Warmup complete");
    });

    let cors = cors_layer();

    let app = Router::new()
        .route("/health", get(health))
        .route("/voices", get(list_voices))
        .route("/tts", post(tts))
        .route("/tts/stream", post(tts_stream))
        .with_state(state)
        .layer(cors);

    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8080);
    let addr: std::net::SocketAddr = ([0, 0, 0, 0], port).into();
    eprintln!("[TTS] Binding to {addr}...");
    axum::serve(tokio::net::TcpListener::bind(addr).await.unwrap(), app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();
    Ok(())
}

async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    
    let mut sigterm = signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
    let mut sigint = signal(SignalKind::interrupt()).expect("failed to install SIGINT handler");
    
    tokio::select! {
        _ = sigterm.recv() => {
            info!("Received SIGTERM, shutting down...");
        }
        _ = sigint.recv() => {
            info!("Received SIGINT, shutting down...");
        }
    }
}

fn cors_layer() -> CorsLayer {
    let origins: Vec<HeaderValue> = std::env::var("CORS_ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "https://epub2voice.org,https://www.epub2voice.org,http://localhost:3000,http://127.0.0.1:3000".to_string())
        .split(',')
        .filter_map(|origin| {
            let origin = origin.trim();
            if origin.is_empty() {
                None
            } else {
                HeaderValue::from_str(origin).ok()
            }
        })
        .collect();

    let base = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);

    if origins.is_empty() {
        base.allow_origin(Any)
    } else {
        base.allow_origin(AllowOrigin::list(origins))
    }
}

fn init_tracing() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::from_default_env().add_directive("axum=info".parse().unwrap()))
        .with(tracing_subscriber::fmt::layer())
        .init();
}

fn load_vocab() -> Result<HashMap<char, i64>, ApiError> {
    let json = include_str!("../config.json");
    let data: serde_json::Value = serde_json::from_str(json).map_err(|e| ApiError::Internal(e.to_string()))?;
    let map = data
        .get("vocab")
        .and_then(|v| v.as_object())
        .ok_or_else(|| ApiError::Internal("vocab missing".into()))?;
    let mut vocab = HashMap::new();
    for (k, v) in map {
        if let Some(ch) = k.chars().next() {
            vocab.insert(ch, v.as_i64().unwrap_or(0));
        }
    }
    Ok(vocab)
}

fn load_model(model_path: &str) -> Result<Session, ApiError> {
    let cpu = CPUExecutionProvider::default();
    let session = Session::builder()
        .map_err(|e| ApiError::Internal(format!("builder: {e}")))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| ApiError::Internal(format!("opt: {e}")))?
        .with_execution_providers([cpu.build()])
        .map_err(|e| ApiError::Internal(format!("provider: {e}")))?
        .commit_from_file(model_path)
        .map_err(|e| ApiError::Internal(format!("model: {e}")))?;

    Ok(session)
}

fn load_voices(path: &str) -> Result<HashMap<String, VoiceTable>, ApiError> {
    let file = std::fs::File::open(path).map_err(|e| ApiError::Internal(format!("voices: {e}")))?;
    let mut reader = NpzReader::new(file).map_err(|e| ApiError::Internal(format!("npz: {e}")))?;
    let mut map = HashMap::new();
    for name in reader.names().map_err(|e| ApiError::Internal(format!("npz names: {e}")))? {
        let arr: Array3<f32> = reader
            .by_name(&name)
            .map_err(|e| ApiError::Internal(format!("voice {name}: {e}")))?;
        // arr shape: (510, 1, 256)
        let mut styles = Vec::with_capacity(arr.len_of(ndarray::Axis(0)));
        for i in 0..arr.len_of(ndarray::Axis(0)) {
            let slice = arr.slice(s![i, 0, ..]).to_owned();
            styles.push(slice.to_vec());
        }
        map.insert(name.trim_end_matches(".npy").to_string(), VoiceTable { styles });
    }
    Ok(map)
}

async fn health(State(_state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy",
        model_loaded: true,
        voices: Some(voice_meta()),
    })
}

async fn list_voices(State(_): State<AppState>) -> Json<VoicesResponse> {
    Json(VoicesResponse {
        voices: voice_meta(),
    })
}

fn voice_meta() -> HashMap<String, VoiceMeta> {
    let mut map = HashMap::new();
    for (k, v) in python_voices::VOICES {
        map.insert(
            k.to_string(),
            VoiceMeta {
                name: v.name.to_string(),
                language: v.language.to_string(),
                gender: v.gender.to_string(),
            },
        );
    }
    map
}

async fn tts(State(state): State<AppState>, Json(req): Json<TtsRequest>) -> Result<Response, ApiError> {
    let start = std::time::Instant::now();
    let voice = req.voice.unwrap_or_else(|| "af_heart".to_string());
    let speed = req.speed.unwrap_or(1.0);
    validate_request(&req.text, &voice, speed, &state)?;

    let _guard = state.semaphore.acquire().await.map_err(|e| ApiError::Internal(e.to_string()))?;
    let wait_time = start.elapsed();
    
    let synth_start = std::time::Instant::now();
    let bytes = synthesize(&state, &req.text, &voice, speed).await?;
    let synth_time = synth_start.elapsed();

    println!("[TTS] {} chars | wait={}ms synth={}ms total={}ms", 
        req.text.len(), wait_time.as_millis(), synth_time.as_millis(), start.elapsed().as_millis());

    let mut headers = HeaderMap::new();
    headers.insert("Content-Type", "audio/wav".parse().unwrap());
    headers.insert("Cache-Control", "no-cache".parse().unwrap());
    Ok((headers, bytes).into_response())
}

async fn tts_stream(
    State(state): State<AppState>,
    Json(req): Json<TtsRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let voice = req.voice.unwrap_or_else(|| "af_heart".to_string());
    let speed = req.speed.unwrap_or(1.0);
    validate_request(&req.text, &voice, speed, &state)?;

    let chunks = split_text_smart(&req.text, 80); // Small chunks for fast delivery (~500ms each)
    let chunk_count = chunks.len();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, ApiError>>(4);

    let state_clone = state.clone();
    tokio::spawn(async move {
        for chunk in chunks {
            let guard = match state_clone.semaphore.acquire().await {
                Ok(g) => g,
                Err(e) => {
                    let _ = tx.send(Err(ApiError::Internal(e.to_string()))).await;
                    return;
                }
            };
            let res = synthesize(&state_clone, &chunk, &voice, speed).await;
            drop(guard);
            match res {
                Ok(wav) => {
                    let text_bytes = chunk.as_bytes();
                    let header = build_chunk_header(wav.len(), text_bytes.len());
                    if tx.send(Ok(Bytes::from([header, text_bytes.to_vec(), wav].concat()))).await.is_err() {
                        return;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e)).await;
                    return;
                }
            }
        }
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx).map(|res| match res {
        Ok(bytes) => Ok::<Bytes, ApiError>(bytes),
        Err(e) => Err(e),
    });

    let body = axum::body::Body::from_stream(stream);
    let mut headers = HeaderMap::new();
    headers.insert("Content-Type", "application/octet-stream".parse().unwrap());
    headers.insert("Cache-Control", "no-cache".parse().unwrap());
    headers.insert(
        "X-Chunk-Count",
        HeaderValue::from_str(&chunk_count.to_string()).unwrap(),
    );
    Ok((headers, body))
}

fn validate_request(text: &str, voice: &str, speed: f32, state: &AppState) -> Result<(), ApiError> {
    if text.trim().is_empty() {
        return Err(ApiError::BadRequest("text is empty".into()));
    }
    if text.len() > 10_000 {
        return Err(ApiError::BadRequest("text too long".into()));
    }
    if speed < 0.5 || speed > 2.0 {
        return Err(ApiError::BadRequest("speed must be between 0.5 and 2.0".into()));
    }
    if !state.voices.contains_key(voice) {
        return Err(ApiError::BadRequest(format!("unknown voice: {voice}")));
    }
    Ok(())
}

async fn synthesize(state: &AppState, text: &str, voice: &str, speed: f32) -> Result<Vec<u8>, ApiError> {
    let t0 = std::time::Instant::now();
    
    let phonemes = phonemize(text, "en-us").await?;
    let t1 = std::time::Instant::now();
    
    let tokens = tokenize(&phonemes)?;
    let style = state
        .voices
        .get(voice)
        .ok_or_else(|| ApiError::BadRequest("unknown voice".into()))?
        .style_for_len(tokens.len())
        .to_vec();
    let t2 = std::time::Instant::now();

    let audio = run_onnx(&state.session, &tokens, &style, speed).await?;
    let t3 = std::time::Instant::now();
    
    let wav = to_wav(&audio)?;
    let t4 = std::time::Instant::now();
    
    println!("  └─ synth breakdown: phonemize={}ms tokenize={}ms onnx={}ms wav={}ms",
        (t1-t0).as_millis(), (t2-t1).as_millis(), (t3-t2).as_millis(), (t4-t3).as_millis());
    
    Ok(wav)
}

async fn phonemize(text: &str, lang: &str) -> Result<String, ApiError> {
    let output = Command::new("espeak-ng")
        .arg("-v")
        .arg(lang)
        .arg("--ipa")
        .arg("-q")
        .arg(text)
        .output()
        .await
        .map_err(|e| ApiError::Internal(format!("espeak: {e}")))?;
    if !output.status.success() {
        return Err(ApiError::Internal(format!("espeak exit {:?}", output.status.code())));
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let filtered: String = raw.chars().filter(|c| VOCAB.contains_key(c)).collect();
    Ok(filtered.trim().to_string())
}

fn tokenize(phonemes: &str) -> Result<Vec<i64>, ApiError> {
    if phonemes.len() > MAX_PHONEME_LENGTH {
        return Err(ApiError::BadRequest("phonemes too long".into()));
    }
    let mut tokens = Vec::with_capacity(phonemes.len() + 2);
    tokens.push(0);
    for ch in phonemes.chars() {
        if let Some(id) = VOCAB.get(&ch) {
            tokens.push(*id);
        }
    }
    tokens.push(0);
    Ok(tokens)
}

async fn run_onnx(
    session: &tokio::sync::Mutex<Session>,
    tokens: &[i64],
    style: &[f32],
    speed: f32,
) -> Result<Vec<f32>, ApiError> {
    // Use tuple-based API (shape, Vec) to avoid ndarray version conflicts
    let tokens_value = Value::from_array(([1, tokens.len()], tokens.to_vec())).map_err(map_ort)?;
    let style_value = Value::from_array(([1, style.len()], style.to_vec())).map_err(map_ort)?;
    let speed_value = Value::from_array(([1], vec![speed])).map_err(map_ort)?;

    let mut session = session.lock().await;
    let outputs = session
        .run(ort::inputs![tokens_value, style_value, speed_value])
        .map_err(map_ort)?;

    let output_tensor = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| ApiError::Internal(format!("tensor extract: {e}")))?
        .1
        .to_vec();
    Ok(output_tensor)
}

fn to_wav(samples: &[f32]) -> Result<Vec<u8>, ApiError> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::new());
    let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| ApiError::Internal(format!("wav: {e}")))?;
    for &s in samples {
        let clamped = (s.max(-1.0).min(1.0) * i16::MAX as f32) as i16;
        writer.write_sample(clamped).map_err(|e| ApiError::Internal(format!("write sample: {e}")))?;
    }
    writer.finalize().map_err(|e| ApiError::Internal(format!("wav finalize: {e}")))?;
    Ok(cursor.into_inner())
}

fn split_text_smart(text: &str, max_len: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    for para in text.split("\n\n").map(|p| p.trim()).filter(|p| !p.is_empty()) {
        if para.len() <= max_len {
            chunks.push(para.to_string());
            continue;
        }
        let sentences: Vec<&str> = para.split_inclusive(['.', '?', '!']).collect();
        let mut buf = String::new();
        for s in sentences {
            let s = s.trim();
            if s.is_empty() {
                continue;
            }
            if buf.len() + s.len() + 1 > max_len {
                if !buf.is_empty() {
                    chunks.push(buf.trim().to_string());
                    buf.clear();
                }
            }
            if !buf.is_empty() {
                buf.push(' ');
            }
            buf.push_str(s);
        }
        if !buf.is_empty() {
            chunks.push(buf.trim().to_string());
        }
    }
    chunks
}

fn build_chunk_header(wav_len: usize, text_len: usize) -> Vec<u8> {
    let mut header = Vec::with_capacity(6);
    header.extend_from_slice(&(wav_len as u32).to_be_bytes());
    header.extend_from_slice(&(text_len as u16).to_be_bytes());
    header
}

fn warmup(state: &AppState) -> impl std::future::Future<Output = ()> {
    let state = state.clone();
    async move {
        let _ = synthesize(&state, "Hello world", "af_heart", 1.0).await;
    }
}

fn map_ort(err: ort::Error) -> ApiError {
    ApiError::Internal(format!("{err}"))
}

mod python_voices {
    pub struct VoiceMeta {
        pub name: &'static str,
        pub language: &'static str,
        pub gender: &'static str,
    }

    pub const VOICES: &[(&str, VoiceMeta)] = &[
        ("af_heart", VoiceMeta { name: "Heart", language: "en-us", gender: "Female" }),
        ("af_alloy", VoiceMeta { name: "Alloy", language: "en-us", gender: "Female" }),
        ("af_aoede", VoiceMeta { name: "Aoede", language: "en-us", gender: "Female" }),
        ("af_bella", VoiceMeta { name: "Bella", language: "en-us", gender: "Female" }),
        ("af_jessica", VoiceMeta { name: "Jessica", language: "en-us", gender: "Female" }),
        ("af_kore", VoiceMeta { name: "Kore", language: "en-us", gender: "Female" }),
        ("af_nicole", VoiceMeta { name: "Nicole", language: "en-us", gender: "Female" }),
        ("af_nova", VoiceMeta { name: "Nova", language: "en-us", gender: "Female" }),
        ("af_river", VoiceMeta { name: "River", language: "en-us", gender: "Female" }),
        ("af_sarah", VoiceMeta { name: "Sarah", language: "en-us", gender: "Female" }),
        ("af_sky", VoiceMeta { name: "Sky", language: "en-us", gender: "Female" }),
        ("am_adam", VoiceMeta { name: "Adam", language: "en-us", gender: "Male" }),
        ("am_echo", VoiceMeta { name: "Echo", language: "en-us", gender: "Male" }),
        ("am_eric", VoiceMeta { name: "Eric", language: "en-us", gender: "Male" }),
        ("am_fenrir", VoiceMeta { name: "Fenrir", language: "en-us", gender: "Male" }),
        ("am_liam", VoiceMeta { name: "Liam", language: "en-us", gender: "Male" }),
        ("am_michael", VoiceMeta { name: "Michael", language: "en-us", gender: "Male" }),
        ("am_onyx", VoiceMeta { name: "Onyx", language: "en-us", gender: "Male" }),
        ("am_puck", VoiceMeta { name: "Puck", language: "en-us", gender: "Male" }),
        ("am_santa", VoiceMeta { name: "Santa", language: "en-us", gender: "Male" }),
        ("bf_emma", VoiceMeta { name: "Emma", language: "en-gb", gender: "Female" }),
        ("bf_isabella", VoiceMeta { name: "Isabella", language: "en-gb", gender: "Female" }),
        ("bf_alice", VoiceMeta { name: "Alice", language: "en-gb", gender: "Female" }),
        ("bf_lily", VoiceMeta { name: "Lily", language: "en-gb", gender: "Female" }),
        ("bm_george", VoiceMeta { name: "George", language: "en-gb", gender: "Male" }),
        ("bm_lewis", VoiceMeta { name: "Lewis", language: "en-gb", gender: "Male" }),
        ("bm_daniel", VoiceMeta { name: "Daniel", language: "en-gb", gender: "Male" }),
        ("bm_fable", VoiceMeta { name: "Fable", language: "en-gb", gender: "Male" }),
    ];
}
