"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, Square, BookOpen, Wifi, WifiOff } from "lucide-react";

// TTS API configuration
const TTS_API_URL = process.env.NEXT_PUBLIC_TTS_API_URL || "http://localhost:8080";
const PREFETCH_CHARS = 50; // Very small for sub-500ms first response
const PREFETCH_LOOKAHEAD = 5; // More chunks to compensate for smaller size

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
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const queueRef = useRef<{ buffer: AudioBuffer; text?: string }[]>([]);
  const prefetchedAudioRef = useRef<{
    buffer: AudioBuffer;
    text: string;
    chars: number;
    voice: string;
    speed: number;
  } | null>(null);
  const prefetchAbortRef = useRef<AbortController | null>(null);
  const playingRef = useRef(false);
  const isStreamingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const totalChunksRef = useRef(0);
  const processedChunksRef = useRef(0);
  const chunkAnimationRef = useRef<number | null>(null);
  // Queue of prefetched audio chunks for instant playback
  const prefetchQueueRef = useRef<{
    buffer: AudioBuffer;
    text: string;
    startChar: number;
    endChar: number;
  }[]>([]);

  const [chapters, setChapters] = useState<(TocItem & { depth: number })[]>([]);
  const [activeHref, setActiveHref] = useState<string | null>(null);
  const [currentText, setCurrentText] = useState(sampleText);
  const [ttsReady, setTtsReady] = useState(false);
  const [voices, setVoices] = useState<Record<string, Voice>>({});
  const [selectedVoice, setSelectedVoice] = useState<string>("af_heart");
  const [cadence, setCadence] = useState(1);
  const [serverStatus, setServerStatus] = useState<"connecting" | "ready" | "error">("connecting");
  const [streamingProgress, setStreamingProgress] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>("Connecting to TTS server...");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamBaseOffset, setStreamBaseOffset] = useState<number>(0);
  const [userScrub, setUserScrub] = useState<number | null>(null);
  const [readChars, setReadChars] = useState(0);
  const readCharsRef = useRef(0);

  // Warmup the TTS server on page load
  useEffect(() => {
    const warmupServer = async () => {
      try {
        setStatusMessage("Connecting to TTS server...");
        setServerStatus("connecting");

        const response = await fetch(`${TTS_API_URL}/health`, {
          method: "GET",
          headers: { "Accept": "application/json" },
        });

        if (!response.ok) {
          throw new Error(`Server returned ${response.status}`);
        }

        const data = await response.json();

        if (data.model_loaded) {
          setTtsReady(true);
          setServerStatus("ready");
          setStatusMessage("TTS server ready");
          if (data.voices) {
            setVoices(data.voices);
            if (data.voices["af_heart"]) {
              setSelectedVoice("af_heart");
            } else {
              setSelectedVoice(Object.keys(data.voices)[0]);
            }
          }
        } else {
          // Model is still loading, poll again
          setTimeout(warmupServer, 2000);
        }
      } catch (error) {
        console.error("Failed to connect to TTS server:", error);
        setServerStatus("error");
        setStatusMessage("TTS server unavailable");
        // Retry connection
        setTimeout(warmupServer, 5000);
      }
    };

    warmupServer();
  }, []);


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

  const prefetchFirstChunk = useCallback(async () => {
    if (!ttsReady || !currentText || isStreamingRef.current) return;

    prefetchAbortRef.current?.abort();
    const controller = new AbortController();
    prefetchAbortRef.current = controller;

    // Clear old prefetch
    prefetchQueueRef.current = [];
    prefetchedAudioRef.current = null;

    // Only prefetch FIRST chunk - no parallel requests to avoid queue delays
    const text = currentText.slice(0, PREFETCH_CHARS).trim();
    if (!text) return;

    console.log(`[Prefetch] Fetching first ${text.length} chars...`);
    const fetchStart = performance.now();

    try {
      const response = await fetch(`${TTS_API_URL}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: selectedVoice,
          speed: cadence,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.warn("[Prefetch] Failed:", response.status);
        return;
      }

      const wav = await response.arrayBuffer();
      const ctx = ensureAudioContext();
      const buffer = await ctx.decodeAudioData(wav.slice(0));

      prefetchedAudioRef.current = {
        buffer,
        text,
        chars: text.length,
        voice: selectedVoice,
        speed: cadence,
      };

      // Also store in queue for new playback code
      prefetchQueueRef.current = [{ buffer, text, startChar: 0, endChar: text.length }];

      console.log(`[Prefetch] Ready in ${Math.round(performance.now() - fetchStart)}ms`);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.warn("[Prefetch] Error:", error);
      }
    } finally {
      if (prefetchAbortRef.current === controller) {
        prefetchAbortRef.current = null;
      }
    }
  }, [cadence, currentText, ensureAudioContext, selectedVoice, ttsReady]);

  // Prefetch first chunk when ready
  useEffect(() => {
    if (!ttsReady || !currentText || isStreaming) return;
    void prefetchFirstChunk();
    return () => {
      prefetchAbortRef.current?.abort();
    };
  }, [ttsReady, currentText, selectedVoice, cadence, isStreaming, prefetchFirstChunk]);

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
    }

    playingRef.current = false;
  }, [ensureAudioContext, currentText]);

  const enqueueAudioFromWav = useCallback(
    async (wavData: ArrayBuffer, textChunk?: string) => {
      if (!isStreamingRef.current) {
        console.log("Skipping audio - streaming stopped");
        return;
      }
      const ctx = ensureAudioContext();
      console.log("Received WAV data:", wavData.byteLength, "bytes, text:", textChunk?.slice(0, 50));

      try {
        // Decode WAV audio data
        const audioBuffer = await ctx.decodeAudioData(wavData.slice(0));
        console.log("Decoded audio buffer:", audioBuffer.duration, "seconds", audioBuffer.numberOfChannels, "channels");
        queueRef.current.push({ buffer: audioBuffer, text: textChunk });
        console.log("Audio queue length:", queueRef.current.length);
        void playQueue();
      } catch (error) {
        console.error("Failed to decode audio:", error);
        console.error("WAV data first bytes:", new Uint8Array(wavData.slice(0, 20)));
      }
    },
    [ensureAudioContext, playQueue],
  );

  const stopAudio = (resetOffset = true) => {
    // Abort any in-flight fetch
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

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
    const nextBoundary = currentText.indexOf(" ", startIndex + 1);
    const start = nextBoundary > -1 ? nextBoundary + 1 : startIndex;
    return currentText.slice(start);
  };

  // Split text into chunks for TTS - 100 chars = ~500ms per chunk
  const splitTextIntoChunks = (text: string, maxLength = 100): string[] => {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point (sentence or paragraph)
      let breakPoint = remaining.lastIndexOf('. ', maxLength);
      if (breakPoint < maxLength * 0.5) {
        breakPoint = remaining.lastIndexOf('? ', maxLength);
      }
      if (breakPoint < maxLength * 0.5) {
        breakPoint = remaining.lastIndexOf('! ', maxLength);
      }
      if (breakPoint < maxLength * 0.5) {
        breakPoint = remaining.lastIndexOf('\n', maxLength);
      }
      if (breakPoint < maxLength * 0.5) {
        breakPoint = remaining.lastIndexOf(' ', maxLength);
      }
      if (breakPoint < 1) {
        breakPoint = maxLength;
      } else {
        breakPoint += 1; // Include the punctuation
      }

      chunks.push(remaining.slice(0, breakPoint).trim());
      remaining = remaining.slice(breakPoint).trim();
    }

    return chunks.filter(c => c.length > 0);
  };

  const startStreamingFrom = async (percent = 0) => {
    if (!ttsReady) {
      setStatusMessage("TTS server not ready yet");
      return;
    }

    const slicedText = sliceTextFromPercent(percent);
    if (!slicedText || slicedText.trim().length === 0) {
      setStatusMessage("No text to stream yet.");
      return;
    }

    stopAudio(false);

    // Check if we have prefetched chunks ready for instant playback
    const prefetchQueue = prefetchQueueRef.current;
    const canUsePrefetch =
      percent === 0 &&
      prefetchQueue.length > 0 &&
      prefetchedAudioRef.current?.voice === selectedVoice &&
      prefetchedAudioRef.current?.speed === cadence;

    let leadChars = 0;
    if (canUsePrefetch) {
      // Queue ALL prefetched chunks for instant playback!
      for (const chunk of prefetchQueue) {
        queueRef.current.push({ buffer: chunk.buffer, text: chunk.text });
        leadChars = chunk.endChar; // Track where prefetched audio ends
      }
      void playQueue(); // Start playing immediately
      console.log(`Using ${prefetchQueue.length} prefetched audio chunks (${leadChars} chars)`);
      setStatusMessage("Playing...");
    }

    // Calculate remaining text after prefetched content
    const remainingText = slicedText.slice(leadChars).trim();

    // If all text was prefetched, we're done fetching
    if (!remainingText) {
      setIsStreaming(true);
      isStreamingRef.current = true;
      setStreamingProgress(100);
      return;
    }

    // Split remaining text into chunks for the API
    const textChunks = splitTextIntoChunks(remainingText);
    console.log(`Streaming ${textChunks.length} additional text chunks`);

    const offsetChars = Math.floor((percent / 100) * (currentText?.length || 0)) + leadChars;
    setReadChars(canUsePrefetch ? 0 : offsetChars);
    readCharsRef.current = canUsePrefetch ? 0 : offsetChars;
    setStreamBaseOffset(percent);
    setIsStreaming(true);
    isStreamingRef.current = true;
    if (!canUsePrefetch) setStatusMessage("Generating audio...");
    processedChunksRef.current = canUsePrefetch ? prefetchQueue.length : 0;
    totalChunksRef.current = textChunks.length + (canUsePrefetch ? prefetchQueue.length : 0);
    setStreamingProgress(
      totalChunksRef.current > 0
        ? Math.round((processedChunksRef.current / totalChunksRef.current) * 100)
        : 0,
    );
    scrollRenditionToPercent(percent);

    // Create abort controller for this request
    abortControllerRef.current = new AbortController();

    try {
      // Process each text chunk sequentially
      for (let chunkIndex = 0; chunkIndex < textChunks.length; chunkIndex++) {
        if (!isStreamingRef.current) break;

        const textChunk = textChunks[chunkIndex];
        setStatusMessage(`Generating audio (${chunkIndex + 1}/${textChunks.length})...`);

        const response = await fetch(`${TTS_API_URL}/tts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: textChunk,
            voice: selectedVoice,
            speed: cadence,
          }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          const errorBody = await response.text();
          console.error("TTS API error:", response.status, errorBody);
          throw new Error(`TTS request failed: ${response.status} - ${errorBody}`);
        }

        // Simple: just get the WAV and enqueue it
        const wavData = await response.arrayBuffer();
        await enqueueAudioFromWav(wavData, textChunk);

        // Update progress after each chunk
        const completed = (canUsePrefetch ? prefetchQueue.length : 0) + chunkIndex + 1;
        processedChunksRef.current = completed;
        setStreamingProgress(
          totalChunksRef.current > 0
            ? Math.round((completed / totalChunksRef.current) * 100)
            : 0,
        );
      }

      setIsStreaming(false);
      isStreamingRef.current = false;
      setStatusMessage("Complete");
      setStreamingProgress(100);

    } catch (error) {
      if ((error as Error).name === "AbortError") {
        console.log("TTS request aborted");
      } else {
        console.error("TTS error:", error);
        setStatusMessage(`Error: ${(error as Error).message}`);
      }
      setIsStreaming(false);
      isStreamingRef.current = false;
    }
  };

  const handleFile = async (file: File) => {
    const { default: ePub } = await import("epubjs");

    console.log("Opening EPUB file:", file.name, file.size, file.type);
    bookRef.current?.destroy?.();
    renditionRef.current?.destroy?.();

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
      const pausePoint = effective;
      stopAudio(false);
      setStreamBaseOffset(pausePoint);
      setStatusMessage("Paused");
      return;
    }
    void startStreamingFrom(streamBaseOffset || 0);
  };

  const handleTimelineScrub = (value: number) => {
    setUserScrub(value);
  };

  const commitTimelineScrub = (value: number) => {
    setUserScrub(null);
    void startStreamingFrom(value);
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

  // Server status indicator component
  const ServerStatusBadge = () => {
    const statusConfig = {
      connecting: { icon: Wifi, color: "text-yellow-500", label: "Connecting..." },
      ready: { icon: Wifi, color: "text-green-500", label: "Ready" },
      error: { icon: WifiOff, color: "text-red-500", label: "Offline" },
    };
    const config = statusConfig[serverStatus];
    const Icon = config.icon;

    return (
      <div className={`flex items-center gap-1.5 text-xs ${config.color}`}>
        <Icon className="h-3.5 w-3.5" />
        <span>{config.label}</span>
      </div>
    );
  };

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
            Upload an EPUB and stream your audio. Blazing fast.
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
                <BookOpen className="h-4 w-4" /> Upload EPUB
              </label>
              <ServerStatusBadge />
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
                  disabled={!ttsReady}
                >
                  {isStreaming ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  {isStreaming ? "Pause" : "Play"}
                </button>
                <div className="card px-3 py-2 text-xs text-[var(--muted)]">{statusMessage}</div>
              </div>

              <div className="space-y-3">
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
              disabled={!ttsReady}
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
