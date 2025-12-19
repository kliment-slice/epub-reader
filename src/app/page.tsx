"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, Square, BookOpen } from "lucide-react";

type Voice = {
  name: string;
  language: string;
  gender: string;
};

type TocItem = {
  id?: string;
  href: string;
  label: string;
  subitems?: TocItem[];
};

const sampleText =
  "Upload an EPUB to get started.";

type EpubContent = { document?: Document | null };

type EpubRendition = {
  display: (href?: string) => Promise<void>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  getContents?: () => EpubContent[];
  currentLocation?: () => { start?: { href?: string } };
  destroy?: () => void;
};

type EpubBook = {
  renderTo: (
    element: HTMLElement,
    options: {
      width: string;
      height: string;
      spread: string;
      flow: string;
      allowScriptedContent?: boolean;
    },
  ) => EpubRendition;
  loaded: { navigation: Promise<{ toc: TocItem[] }> };
  load: (url: string) => Promise<Document | string>;
  spine?: {
    get?: (href?: string) => { href?: string; render?: () => Promise<string>; unload?: () => Promise<void> };
    items?: { href?: string }[];
  };
  destroy?: () => void;
};

const flattenToc = (
  items: TocItem[] = [],
  depth = 0,
): (TocItem & { depth: number })[] => items.flatMap((item) => [
  { ...item, depth },
  ...flattenToc(item.subitems || [], depth + 1),
]);

export default function Home() {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const renditionRef = useRef<EpubRendition | null>(null);
  const bookRef = useRef<EpubBook | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const queueRef = useRef<{ buffer: AudioBuffer; text?: string }[]>([]);
  const playingRef = useRef(false);
  const isStreamingRef = useRef(false);
  const totalChunksRef = useRef(0);
  const processedChunksRef = useRef(0);
  const chunkAnimationRef = useRef<number | null>(null);

  const [chapters, setChapters] = useState<(TocItem & { depth: number })[]>([]);
  const [activeHref, setActiveHref] = useState<string | null>(null);
  const [currentText, setCurrentText] = useState(sampleText);
  const [ttsReady, setTtsReady] = useState(false);
  const [voices, setVoices] = useState<Record<string, Voice>>({});
  const [selectedVoice, setSelectedVoice] = useState<string>("af_heart");
  const [cadence, setCadence] = useState(1);
  const [loadingProgress, setLoadingProgress] = useState<number>(0);
  const [streamingProgress, setStreamingProgress] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>("Model not loaded yet");
  const [isStreaming, setIsStreaming] = useState(false);
  const [device, setDevice] = useState<string | null>(null);
  const [streamBaseOffset, setStreamBaseOffset] = useState<number>(0); // where the current stream starts (0-100)
  const [userScrub, setUserScrub] = useState<number | null>(null);
  const [readChars, setReadChars] = useState(0);
  const readCharsRef = useRef(0);

  const ensureAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  }, []);

  const getWordBoundaries = (text: string) => {
    const boundaries = [0];
    let sum = 0;
    const regex = /(\S+)(\s*)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      sum += match[0].length;
      boundaries.push(sum);
    }
    if (boundaries.length === 1) {
      boundaries.push(text.length);
    }
    return boundaries;
  };

  const normalizeForPlayback = (text: string) => text.replace(/\s+/g, " ").trim();

  const playQueue = useCallback(async () => {
    if (playingRef.current) return;
    playingRef.current = true;
    const ctx = ensureAudioContext();

    while (queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (!next) break;
      const { buffer, text } = next;
      const source = ctx.createBufferSource();
      sourceRef.current = source;
      source.buffer = buffer;
      source.connect(ctx.destination);
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      // animate highlight over the duration of this chunk
      if (chunkAnimationRef.current) {
        cancelAnimationFrame(chunkAnimationRef.current);
      }
      const startChars = readCharsRef.current;
      const chunkText = text || "";
      const boundaries = getWordBoundaries(chunkText);
      const totalWords = Math.max(1, boundaries.length - 1);
      const durationMs = Math.max(1, buffer.duration * 1000);
      const startTime = performance.now();
      const step = () => {
        const elapsed = performance.now() - startTime;
        const pct = Math.min(1, elapsed / durationMs);
        const wordsRead = Math.min(totalWords, Math.floor(pct * totalWords));
        const charsIntoChunk = boundaries[wordsRead] ?? boundaries[boundaries.length - 1];
        const currentChars = Math.min(currentText.length, startChars + charsIntoChunk);
        readCharsRef.current = currentChars;
        setReadChars(currentChars);
        if (pct < 1 && isStreamingRef.current) {
          chunkAnimationRef.current = requestAnimationFrame(step);
        }
      };
      chunkAnimationRef.current = requestAnimationFrame(step);

      await new Promise<void>((resolve) => {
        source.onended = () => resolve();
        source.start();
      });
      const newCount = Math.min(currentText.length, startChars + boundaries[boundaries.length - 1]);
      readCharsRef.current = newCount;
      setReadChars(newCount);
      processedChunksRef.current += 1;
      if (totalChunksRef.current > 0) {
        const pct = Math.min(
          Math.round((processedChunksRef.current / totalChunksRef.current) * 100),
          99,
        );
        setStreamingProgress(pct);
      }
      workerRef.current?.postMessage({ type: "buffer_processed" });
    }

    playingRef.current = false;
  }, [ensureAudioContext]);

  const enqueueAudio = useCallback(
    (audioBuffer: ArrayBuffer, textChunk?: string) => {
      if (!isStreamingRef.current) return;
      const ctx = ensureAudioContext();
      const floatData = new Float32Array(audioBuffer);
      const buffer = ctx.createBuffer(1, floatData.length, 24000);
      buffer.copyToChannel(floatData, 0, 0);
      queueRef.current.push({ buffer, text: textChunk });
      void playQueue();
    },
    [ensureAudioContext, playQueue],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const worker = new Worker("/kokoro/worker.js", { type: "module" });
    workerRef.current = worker;

    const handleMessage = (e: MessageEvent) => {
      switch (e.data.status) {
        case "loading_model_start":
          setDevice(e.data.device);
          setStatusMessage("Loading Kokoro weights...");
          setLoadingProgress(0);
          break;
        case "loading_model_progress":
          setLoadingProgress(Math.round(Number(e.data.progress) * 100));
          setStatusMessage("Downloading model...");
          break;
        case "loading_model_ready":
          setTtsReady(true);
          setVoices(e.data.voices || {});
          setStatusMessage("Model ready");
          setLoadingProgress(100);
          if (e.data.voices && e.data.voices["af_heart"]) {
            setSelectedVoice("af_heart");
          } else if (e.data.voices) {
            setSelectedVoice(Object.keys(e.data.voices)[0]);
          }
          break;
        case "chunk_count":
          totalChunksRef.current = e.data.count;
          processedChunksRef.current = 0;
          setStreamingProgress(0);
          break;
        case "stream_audio_data":
          enqueueAudio(e.data.audio, e.data.text);
          break;
        case "complete":
          setIsStreaming(false);
          isStreamingRef.current = false;
          setStatusMessage("Streaming complete");
          setStreamingProgress(100);
          queueRef.current = [];
          break;
        case "error":
          console.error("Worker sent error:", e.data.error);
          setStatusMessage(`Error: ${e.data.error}`);
          setIsStreaming(false);
          isStreamingRef.current = false;
          break;
        default:
          break;
      }
    };

    const handleError = (err: ErrorEvent) => {
      console.error("Worker error", err);
      setStatusMessage("Something went wrong while streaming.");
      setIsStreaming(false);
      isStreamingRef.current = false;
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);

    return () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      worker.terminate();
      audioContextRef.current?.close();
    };
  }, [enqueueAudio]);

  const stopAudio = (resetOffset = true) => {
    queueRef.current = [];
    processedChunksRef.current = 0;
    totalChunksRef.current = 0;
    sourceRef.current?.stop();
    playingRef.current = false;
    setIsStreaming(false);
    isStreamingRef.current = false;
    if (chunkAnimationRef.current) {
      cancelAnimationFrame(chunkAnimationRef.current);
      chunkAnimationRef.current = null;
    }
    setStreamingProgress(0);
    if (resetOffset) {
      setStreamBaseOffset(0);
      setReadChars(0);
      readCharsRef.current = 0;
    }
    workerRef.current?.postMessage({ type: "stop" });
  };

  const getEffectiveProgress = () => {
    return Math.min(
      100,
      streamBaseOffset + streamingProgress * (1 - streamBaseOffset / 100),
    );
  };

  const scrollRenditionToPercent = (percent: number) => {
    const pct = Math.min(100, Math.max(0, percent)) / 100;
    const contents = (renditionRef.current?.getContents?.() || []) as EpubContent[];
    contents.forEach((content) => {
      const el = content.document?.documentElement || content.document?.body;
      if (!el) return;
      const target = (el.scrollHeight - el.clientHeight) * pct;
      // Use instant scroll to avoid aggressive smooth scrolling jumps
      el.scrollTo({ top: target, behavior: "auto" });
    });
    if (overlayRef.current) {
      const overlay = overlayRef.current;
      const target = (overlay.scrollHeight - overlay.clientHeight) * pct;
      overlay.scrollTo({ top: target, behavior: "auto" });
    }
  };

  const sliceTextFromPercent = (percent: number) => {
    if (!currentText) return "";
    const pct = Math.min(100, Math.max(0, percent));
    const startIndex = Math.floor((pct / 100) * currentText.length);
    // Avoid starting mid-word by jumping to the next whitespace boundary if possible
    const nextBoundary = currentText.indexOf(" ", startIndex + 1);
    const start = nextBoundary > -1 ? nextBoundary + 1 : startIndex;
    return currentText.slice(start);
  };

  const startStreamingFrom = (percent = 0) => {
    if (!workerRef.current) {
      setStatusMessage("No TTS worker available.");
      return;
    }
    const slicedText = sliceTextFromPercent(percent);
    if (!slicedText) {
      setStatusMessage("No text to stream yet.");
      return;
    }
    const offsetChars = Math.floor((percent / 100) * (currentText?.length || 0));
    setReadChars(offsetChars);
    readCharsRef.current = offsetChars;
    stopAudio(false);
    setStreamBaseOffset(percent);
    setIsStreaming(true);
    isStreamingRef.current = true;
    setStatusMessage("Generating audio...");
    processedChunksRef.current = 0;
    totalChunksRef.current = 0;
    setStreamingProgress(0);
    scrollRenditionToPercent(percent);
    workerRef.current.postMessage({
      text: slicedText,
      voice: selectedVoice,
      speed: cadence,
    });
  };

  const handleFile = async (file: File) => {
    const { default: ePub } = await import("epubjs");

    console.log("Opening EPUB file:", file.name, file.size, file.type);
    bookRef.current?.destroy?.();
    renditionRef.current?.destroy?.();

    // Read the file into an ArrayBuffer so ePub opens it as a binary archive instead of a URL
    const buffer = await file.arrayBuffer();
    const book = ePub(buffer, { openAs: "binary" }) as unknown as EpubBook;
    bookRef.current = book;

    const rendition = book.renderTo(viewerRef.current!, {
      width: "100%",
      height: "100%",
      spread: "none",
      flow: "scrolled-doc",
      allowScriptedContent: true,
    });
    renditionRef.current = rendition;

    rendition.on("rendered", (_section, view) => {
      console.log("Rendition rendered view:", view);
      const iframe = (view as { iframe?: HTMLIFrameElement }).iframe;
      if (iframe) {
        // Remove sandboxing so we can read text and keep scripts working
        iframe.removeAttribute("sandbox");
        iframe.allow = "autoplay; encrypted-media";
      }
      captureCurrentText();
    });
    rendition.on("relocated", (location) => {
      console.log("Rendition relocated warning:", location);
      captureCurrentText();
    });

    try {
      await rendition.display();
      console.log("Initial rendition displayed");
    } catch (err) {
      console.error("Initial rendition display failed:", err);
    }

    const nav = await book.loaded.navigation;
    console.log("Navigation loaded:", nav);
    console.log("Spine loaded:", book.spine);
    const toc = flattenToc(nav.toc || []);
    setChapters(toc);
    if (toc.length > 0) {
      const firstHref = resolveChapterHref(toc[0].href);
      setActiveHref(firstHref);
      await rendition.display(firstHref).catch((err) => {
        console.warn("Failed to display first chapter:", err);
        return rendition.display().catch(() => { });
      });
    }
    captureCurrentText();
  };

  const resolveChapterHref = (href: string) => {
    const clean = href.split("#")[0];
    const spineItems = bookRef.current?.spine?.items || [];
    const match = spineItems.find((item) => item.href === clean || item.href?.endsWith(clean));
    return match?.href || clean || href;
  };

  const captureCurrentText = () => {
    const contents = (renditionRef.current?.getContents?.() || []) as EpubContent[];
    const text = contents
      .map((content) => content.document?.body?.innerText || "")
      .filter(Boolean)
      .join("\n");
    const normalized = normalizeForPlayback(text);
    if (normalized) {
      console.log("Captured text from rendition");
      setCurrentText(normalized);
      setReadChars(0);
      readCharsRef.current = 0;
    } else {
      console.log("No text in rendition, falling back to hydrateTextFallback");
      void hydrateTextFallback();
    }
  };

  const hydrateTextFallback = async () => {
    const spine = bookRef.current?.spine;
    const liveHref =
      renditionRef.current?.currentLocation?.()?.start?.href || activeHref || spine?.items?.[0]?.href;

    console.log("hydrateTextFallback. Live href:", liveHref);
    if (!liveHref || !bookRef.current) return;

    // Use book.load() which correctly handles the internal archive/buffer
    // section.render() tries to fetch via XHR relative to the page, causing 404s for local blobs
    try {
      console.log("Attempting book.load() for:", liveHref);
      const content = await bookRef.current.load(liveHref);
      console.log("book.load() result type:", typeof content, content instanceof Document ? "Document" : "String");

      let bodyText = "";

      if (content instanceof Document) {
        bodyText = content.body.textContent || "";
      } else if (typeof content === "string") {
        const doc = new DOMParser().parseFromString(content, "text/html");
        bodyText = doc.body.textContent || "";
      }

      const normalized = normalizeForPlayback(bodyText);
      if (normalized) {
        console.log("Text fallback successful");
        setCurrentText(normalized);
      } else {
        console.warn("Text fallback found content but empty body text");
      }
    } catch (err) {
      console.warn("EPUB content load failed", err);
    }
  };

  const handleChapterSelect = async (href: string) => {
    if (!renditionRef.current) return;
    console.log("Selected chapter:", href);
    const resolved = resolveChapterHref(href);
    setActiveHref(resolved);
    await renditionRef.current.display(resolved).catch(async (err) => {
      console.warn("Display chapter failed:", err);
      // Try falling back to a best-effort match in the spine
      const fallback = bookRef.current?.spine?.items?.[0]?.href;
      if (fallback) {
        console.warn("Retrying with fallback spine href:", fallback);
        return renditionRef.current?.display(fallback).catch(() => { });
      }
      return renditionRef.current?.display().catch(() => { });
    });
    captureCurrentText();
  };

  const startStreaming = () => {
    const effective = getEffectiveProgress();
    if (isStreaming) {
      // Treat as pause: capture where we are, then stop but keep offset
      const pausePoint = effective;
      stopAudio(false);
      setStreamBaseOffset(pausePoint);
      setStatusMessage("Paused");
      return;
    }
    startStreamingFrom(streamBaseOffset || 0);
  };

  const handleTimelineScrub = (value: number) => {
    setUserScrub(value);
  };

  const commitTimelineScrub = (value: number) => {
    setUserScrub(null);
    startStreamingFrom(value);
  };

  const timelinePercent = userScrub ?? getEffectiveProgress();
  const readPointer = Math.min(readChars, currentText.length);
  const findWordStart = () => {
    for (let i = readPointer - 1; i >= 0; i -= 1) {
      if (/\s/.test(currentText[i])) return i + 1;
    }
    return 0;
  };
  const findWordEnd = () => {
    for (let i = readPointer; i < currentText.length; i += 1) {
      if (/\s/.test(currentText[i])) return i;
    }
    return currentText.length;
  };
  const wordStart = findWordStart();
  const wordEnd = Math.max(wordStart, findWordEnd());
  const beforeWord = currentText.slice(0, wordStart);
  const activeWord = currentText.slice(wordStart, wordEnd) || " ";
  const afterWord = currentText.slice(wordEnd);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || currentText.length === 0) return;
    const pct = readChars / currentText.length;
    const target = (overlay.scrollHeight - overlay.clientHeight) * pct;
    overlay.scrollTo({ top: target, behavior: "auto" });
  }, [readChars, currentText.length]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <div className="pointer-events-none absolute inset-0 -z-10 opacity-90">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_15%,rgba(240,117,34,0.14),transparent_35%),radial-gradient(circle_at_85%_10%,rgba(240,117,34,0.1),transparent_40%),radial-gradient(circle_at_70%_80%,rgba(240,117,34,0.12),transparent_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,rgba(0,0,0,0.08),transparent_22%),radial-gradient(circle_at_100%_100%,rgba(0,0,0,0.08),transparent_20%)] mix-blend-multiply" />
        <div className="absolute inset-0 bg-[var(--bg)]/65 backdrop-blur-[1px]" />
      </div>

      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 pb-32">
        <header className="surface px-6 py-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-3xl font-semibold tracking-tight">Free EPUB reader</h1>
            </div>
          </div>
          <p className="mt-3 text-sm text-[var(--muted)]">
            Drop an EPUB, browse chapters, choose a voice, and stream audio with adjustable cadence.
          </p>
        </header>

        <main className="grid grid-cols-1 gap-6 lg:grid-cols-[1.6fr_1fr]">
          <section className="surface p-5">
            <div className="flex flex-wrap items-center gap-4 border-b border-[var(--stroke)] pb-4">
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-stone-600 bg-stone-700 px-2 py-1 text-sm font-semibold text-[var(--text)] hover:text-[var(--accent)]">
                <input
                  className="hidden"
                  type="file"
                  accept=".epub"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file);
                    e.target.value = "";
                  }}
                />
                <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />
                <BookOpen className="h-4 w-4" /> Select EPUB
              </label>
              <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                <span className="h-2 w-2 rounded-full bg-[var(--accent)]/60" />
                {loadingProgress > 0
                  ? `Model ${loadingProgress}%`
                  : "Model loads on first play (downloads once)"}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 pt-4 lg:grid-cols-[240px_1fr]">
              <div className="card p-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Chapters</h3>
                  <span className="text-xs text-[var(--muted)]">{chapters.length || 0}</span>
                </div>
                <div className="divider my-2" />
                <div className="space-y-1 overflow-y-auto text-sm" style={{ maxHeight: "62vh" }}>
                  {chapters.length === 0 && (
                    <p className="text-xs text-[var(--muted)]">Load an EPUB to see its navigation.</p>
                  )}
                  {chapters.map((chapter) => {
                    const active = activeHref === chapter.href;
                    const base = active ? "text-[var(--accent-strong)]" : "text-[var(--text)]";
                    return (
                      <button
                        key={`${chapter.href}-${chapter.label}`}
                        onClick={() => handleChapterSelect(chapter.href)}
                        className={`flex w-full items-center gap-2 px-2 py-1 text-left transition-colors ${base} hover:text-[var(--accent)]`}
                        style={{ paddingLeft: `${8 + chapter.depth * 12}px` }}
                      >
                        <span className="inline-block h-[2px] w-6 rounded bg-[var(--stroke)]" />
                        <span className="line-clamp-1">{chapter.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="relative min-h-[520px] card p-4 lg:min-h-[640px]">
                <div ref={viewerRef} className="relative h-[500px] w-full overflow-hidden rounded-xl border border-[var(--stroke)] bg-[var(--card)] opacity-0 lg:h-[620px]" />
                <div className="pointer-events-none absolute inset-4 rounded-xl border border-[var(--stroke)] bg-[var(--card)] shadow-inner">
                  <div ref={overlayRef} className="h-full overflow-y-auto rounded-xl p-4 text-sm leading-relaxed">
                    <span className="text-[var(--muted)]">{beforeWord}</span>
                    <span className="rounded bg-[var(--accent)]/35 px-1 text-[var(--text)] transition-colors duration-150">
                      {activeWord}
                    </span>
                    <span className="text-[var(--muted)]/80">{afterWord}</span>
                  </div>
                  <div className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-b from-transparent via-transparent to-[var(--overlay)]" />
                </div>
              </div>
            </div>
          </section>

          <aside className="surface p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Text to speech</h2>
              <span className="text-xs text-[var(--muted)]">Kokoro</span>
            </div>
            <div className="divider my-4" />
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="label">Voice</label>
                <select
                  className="w-full bg-transparent px-3 py-2 text-sm"
                  value={selectedVoice}
                  onChange={(e) => setSelectedVoice(e.target.value)}
                  disabled={!ttsReady || Object.keys(voices).length === 0}
                >
                  {Object.entries(voices).map(([key, v]) => (
                    <option key={key} value={key}>
                      {v.name} · {v.language} ({v.gender})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="flex items-center justify-between label">
                  Cadence
                  <span className="text-[11px] font-semibold text-[var(--accent)]">{cadence.toFixed(2)}x</span>
                </label>
                <input
                  type="range"
                  min={0.75}
                  max={1.5}
                  step={0.05}
                  value={cadence}
                  onChange={(e) => setCadence(Number(e.target.value))}
                  className="range w-full"
                  style={{ accentColor: "var(--accent)" }}
                />
              </div>

              <div className="space-y-2">
                <label className="label">Current text</label>
                <textarea
                  className="h-32 w-full bg-transparent p-3 text-sm"
                  value={currentText}
                  onChange={(e) => setCurrentText(normalizeForPlayback(e.target.value))}
                />
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={startStreaming}
                  className="flex flex-1 items-center gap-2 text-left text-base font-semibold text-[var(--text)] hover:text-[var(--accent)]"
                  disabled={!ttsReady && !loadingProgress}
                >
                  {isStreaming ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  {isStreaming ? "Pause" : "Play"}
                </button>
                <div className="card px-3 py-2 text-xs text-[var(--muted)]">{statusMessage}</div>
              </div>

              <div className="space-y-3">
                <div className="flex justify-between text-xs text-[var(--muted)]">
                  <span>Model</span>
                  <span>{loadingProgress}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--stroke)]">
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-all"
                    style={{ width: `${loadingProgress}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-[var(--muted)]">
                  <span>Streaming</span>
                  <span>{streamingProgress}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--stroke)]">
                  <div
                    className="h-full rounded-full bg-[var(--accent-strong)] transition-all"
                    style={{ width: `${streamingProgress}%` }}
                  />
                </div>
              </div>
            </div>
          </aside>
        </main>
      </div>
      <footer className="fixed bottom-0 left-0 right-0 z-20 border-t border-[var(--stroke)] bg-[var(--surface)]/95 backdrop-blur shadow-[0_-12px_38px_rgba(0,0,0,0.22)]">
        <div className="mx-auto max-w-6xl space-y-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <button
              onClick={startStreaming}
              className="flex items-center gap-2 text-sm font-semibold"
              disabled={!ttsReady && !loadingProgress}
            >
              {isStreaming ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {isStreaming ? "Pause" : "Play"}
            </button>
            <div className="flex-1 text-center">
              <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Now streaming</p>
              <p className="text-xs font-semibold text-[var(--text)] line-clamp-1">{statusMessage}</p>
            </div>
            <button
              onClick={() => stopAudio()}
              className="flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--accent)]"
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </button>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-[var(--muted)]">
            <span className="min-w-[36px] text-left">0%</span>
            <div className="relative w-full py-2">
              <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--stroke)]" />
              <div
                className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--accent)] transition-all"
                style={{ width: `${timelinePercent}%` }}
              />
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={timelinePercent}
                onChange={(e) => handleTimelineScrub(Number(e.target.value))}
                onMouseUp={(e) => commitTimelineScrub(Number(e.currentTarget.value))}
                onTouchEnd={(e) => commitTimelineScrub(Number((e.target as HTMLInputElement).value))}
                className="absolute inset-0 w-full cursor-pointer opacity-0"
                style={{ accentColor: "var(--accent)" }}
              />
            </div>
            <span className="min-w-[48px] text-right">{Math.round(timelinePercent)}%</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
