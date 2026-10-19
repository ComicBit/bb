import { createMicrophoneRecordingStream } from "@/lib/microphone-recording-stream";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMicrophoneSignal } from "./useMicrophoneSignal";
import { useAudioInputDevices } from "./useAudioInputDevices";
import { appToast } from "@/components/ui/app-toast";
import { saveFile } from "@/lib/save-file";
import {
  beginVoiceCapture,
  deleteVoiceRecording,
  deleteVoiceRecordingsForKey,
  failVoiceRecording,
  recordingFileName,
  saveVoiceRecording,
  startVoiceRecordingRetry,
  finishVoiceRecordingRetry,
  useFailedVoiceRecordings,
  type FailedVoiceRecording,
  type VoiceDelivery,
  type VoiceRecording,
} from "@/lib/voice-recording-store";
import {
  requestAudioInputStream,
  useAudioInputDevicePreferenceValue,
} from "@/lib/audio-input-device-preference";
import {
  isDocumentVisible,
  subscribeToDocumentVisibility,
} from "@/lib/document-visibility";
import {
  readVoiceSupportEnvironment,
  resolveVoiceSupport,
  voiceUnsupportedMessage,
  type VoiceUnsupportedReason,
} from "./voice-input-support";

type VoiceInputState = "idle" | "recording" | "transcribing" | "error";

interface UseVoiceInputOptions {
  recordingKey: string | null;
  onTranscript: (
    transcript: string,
    delivery: VoiceDelivery,
  ) => void | Promise<void>;
  onTranscribe: (args: {
    file: File;
    promptContext?: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  getPromptContext?: () => string | undefined;
  playCompletionTransition?: () => Promise<void> | undefined;
}

type TranscriptionResult =
  | { kind: "transcript"; text: string }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

const MIN_RECORDING_DURATION_MS = 1_000;
const CHUNK_TIMESLICE_MS = 250;
let nextEphemeralRecordingKey = 0;

const HTML_DOCUMENT_PATTERN = /<!doctype html|<html[\s>]/i;

function normalizeTranscript(rawText: string): string {
  return rawText.replace(/\s+/g, " ").trim();
}

function sanitizeErrorMessage(raw: string): string | null {
  let normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  const htmlDocumentMatch = normalized.search(HTML_DOCUMENT_PATTERN);
  if (htmlDocumentMatch >= 0) {
    normalized = normalized.slice(0, htmlDocumentMatch).trim();
  }
  if (normalized.length === 0) {
    return null;
  }

  normalized = normalized.replace(/^HTTP\s+\d{3}:\s*/i, "").trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized;
}

function resolveRecordingErrorMessage(
  error: unknown,
  hasPreferredAudioInput = false,
): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone permission denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return hasPreferredAudioInput
          ? "Selected microphone was not found"
          : "No microphone was found";
      case "NotReadableError":
      case "TrackStartError":
        return "Microphone is unavailable or already in use";
      case "AbortError":
        return "Voice capture was aborted";
      default:
        return "Failed to start voice recording";
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    const message = sanitizeErrorMessage(error.message);
    if (message) {
      return message;
    }
  }
  return "Voice input failed";
}

function resolvePreferredAudioMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = ["audio/webm", "audio/mp4", "audio/ogg"];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function useVoiceInput(options: UseVoiceInputOptions) {
  const preferredAudioInputDeviceId = useAudioInputDevicePreferenceValue();
  const {
    devices,
    hasDeviceAccess,
    refresh: refreshDevices,
  } = useAudioInputDevices();
  const [captureError, setCaptureError] = useState<string | null>(null);
  const recordingStreamRef = useRef<ReturnType<
    typeof createMicrophoneRecordingStream
  > | null>(null);
  const deviceRequestRef = useRef(0);
  const startingRef = useRef(false);
  const recordingPreferenceRef = useRef(preferredAudioInputDeviceId);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtMsRef = useRef<number | null>(null);
  const promptContextRef = useRef<string | undefined>(undefined);
  const stopIntentRef = useRef<"transcribe" | "discard" | "keep">("transcribe");
  const deliveryRef = useRef<VoiceDelivery>("insert");
  const mountedRef = useRef(true);
  const acceptedRecordingPendingRef = useRef(false);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const wakeLockSentinelRef = useRef<WakeLockSentinel | null>(null);
  const wakeLockRequestRef = useRef<Promise<void> | null>(null);
  const shouldHoldWakeLockRef = useRef(false);

  const [state, setState] = useState<VoiceInputState>("idle");
  const [delivery, setDelivery] = useState<VoiceDelivery>("insert");
  const [ephemeralRecordingKey] = useState(
    () => `ephemeral/${(nextEphemeralRecordingKey += 1)}`,
  );
  const recordingKey = options.recordingKey ?? ephemeralRecordingKey;
  const persistRecordings = options.recordingKey !== null;
  const failedRecordings = useFailedVoiceRecordings(recordingKey);
  const [isSupported, setIsSupported] = useState(false);
  const [unsupportedReason, setUnsupportedReason] =
    useState<VoiceUnsupportedReason | null>("unsupported-browser");
  const [stream, setStream] = useState<MediaStream | null>(null);

  const { silent } = useMicrophoneSignal(stream, false);

  useEffect(() => {
    setCaptureError(null);
  }, [preferredAudioInputDeviceId]);

  useEffect(() => {
    if (!stream) return;
    const tracks = stream.getAudioTracks();
    const update = () => {
      setCaptureError(
        tracks.some((track) => track.readyState === "ended")
          ? "Microphone disconnected during recording. Choose another microphone."
          : tracks.some((track) => track.muted)
            ? "Microphone is not providing audio. Check your microphone or choose another."
            : null,
      );
    };
    update();
    for (const track of tracks) {
      track.addEventListener("mute", update);
      track.addEventListener("unmute", update);
      track.addEventListener("ended", update);
    }
    return () => {
      for (const track of tracks) {
        track.removeEventListener("mute", update);
        track.removeEventListener("unmute", update);
        track.removeEventListener("ended", update);
      }
    };
  }, [stream]);

  const showError = useCallback((message: string) => {
    setState("error");
    appToast.error("Voice input failed", { description: message });
  }, []);

  const stopMediaStream = useCallback(() => {
    deviceRequestRef.current += 1;
    recordingStreamRef.current?.close();
    recordingStreamRef.current = null;
    const stream = streamRef.current;
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const switchMicrophone = useCallback(
    async (deviceId: string | null) => {
      const recordingStream = recordingStreamRef.current;
      if (!recordingStream) return;
      const request = ++deviceRequestRef.current;
      try {
        const next = await requestAudioInputStream(
          navigator.mediaDevices,
          deviceId,
        );
        if (
          deviceRequestRef.current !== request ||
          recordingStreamRef.current !== recordingStream
        ) {
          next.getTracks().forEach((track) => track.stop());
          return;
        }
        try {
          recordingStream.replace(next);
        } catch (error) {
          next.getTracks().forEach((track) => track.stop());
          throw error;
        }
        const previous = streamRef.current;
        streamRef.current = next;
        setStream(next);
        previous?.getTracks().forEach((track) => track.stop());
        setCaptureError(null);
        void refreshDevices();
      } catch (error) {
        if (
          deviceRequestRef.current === request &&
          recordingStreamRef.current === recordingStream
        ) {
          setCaptureError(resolveRecordingErrorMessage(error));
        }
      }
    },
    [refreshDevices],
  );

  useEffect(() => {
    if (state !== "recording" || !stream) return;
    const recover = () => {
      if (!recordingStreamRef.current) return;
      setCaptureError(
        "Microphone disconnected. Switching to an available microphone…",
      );
      void switchMicrophone(null);
    };
    const tracks = stream.getAudioTracks();
    for (const track of tracks) track.addEventListener("ended", recover);
    return () => {
      for (const track of tracks) track.removeEventListener("ended", recover);
    };
  }, [state, stream, switchMicrophone]);

  useEffect(() => {
    if (
      state === "recording" &&
      recordingPreferenceRef.current !== preferredAudioInputDeviceId
    ) {
      recordingPreferenceRef.current = preferredAudioInputDeviceId;
      void switchMicrophone(preferredAudioInputDeviceId);
    }
  }, [state, preferredAudioInputDeviceId, switchMicrophone]);

  const requestRecordingWakeLock = useCallback(() => {
    if (
      typeof window === "undefined" ||
      typeof navigator === "undefined" ||
      typeof document === "undefined" ||
      !("wakeLock" in navigator) ||
      window.isSecureContext === false ||
      document.visibilityState !== "visible"
    ) {
      return;
    }

    const wakeLock = navigator.wakeLock;
    if (!wakeLock) {
      return;
    }

    const currentSentinel = wakeLockSentinelRef.current;
    if (currentSentinel && !currentSentinel.released) {
      return;
    }
    if (wakeLockRequestRef.current) {
      return;
    }

    wakeLockRequestRef.current = wakeLock
      .request("screen")
      .then((sentinel) => {
        if (!shouldHoldWakeLockRef.current) {
          if (!sentinel.released) {
            void sentinel.release().catch(() => {});
          }
          return;
        }

        wakeLockSentinelRef.current = sentinel;
        sentinel.addEventListener("release", () => {
          if (wakeLockSentinelRef.current === sentinel) {
            wakeLockSentinelRef.current = null;
          }
        });
      })
      .catch(() => {})
      .finally(() => {
        wakeLockRequestRef.current = null;
      });
  }, []);

  const releaseRecordingWakeLock = useCallback(() => {
    shouldHoldWakeLockRef.current = false;

    const sentinel = wakeLockSentinelRef.current;
    wakeLockSentinelRef.current = null;
    if (!sentinel || sentinel.released) {
      return;
    }

    void sentinel.release().catch(() => {});
  }, []);

  useEffect(() => {
    const support = resolveVoiceSupport(readVoiceSupportEnvironment());
    setIsSupported(support.isSupported);
    setUnsupportedReason(support.reason);
  }, []);

  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      const acceptedRecordingPending = acceptedRecordingPendingRef.current;
      const recorderActive = recorder?.state === "recording";
      if (recorder && recorderActive) {
        stopIntentRef.current = "keep";
        try {
          recorder.stop();
        } catch {}
      }
      mediaRecorderRef.current = null;
      if (!acceptedRecordingPending && !recorderActive) {
        chunksRef.current = [];
        startedAtMsRef.current = null;
        promptContextRef.current = undefined;
      }
      releaseRecordingWakeLock();
      if (!acceptedRecordingPending) stopMediaStream();
    };
  }, [releaseRecordingWakeLock, stopMediaStream]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (persistRecordings) return;
    return () => deleteVoiceRecordingsForKey(recordingKey);
  }, [persistRecordings, recordingKey]);

  useEffect(() => {
    return subscribeToDocumentVisibility(() => {
      if (isDocumentVisible() && shouldHoldWakeLockRef.current) {
        requestRecordingWakeLock();
      }
    });
  }, [requestRecordingWakeLock]);

  const runTranscription = useCallback(
    async (
      recording: VoiceRecording,
      signal: AbortSignal,
      beforeDelivery: (() => Promise<void> | undefined) | undefined,
    ): Promise<TranscriptionResult> => {
      try {
        const transcript = await options.onTranscribe({
          file: recording.file,
          promptContext: recording.promptContext,
          signal,
        });
        const text = normalizeTranscript(transcript);
        if (!signal.aborted && text.length === 0) {
          throw new Error("Voice transcription returned an empty result.");
        }
        await beforeDelivery?.();
        return signal.aborted
          ? { kind: "cancelled" }
          : { kind: "transcript", text };
      } catch (error) {
        return signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
          ? { kind: "cancelled" }
          : { kind: "failed", message: resolveRecordingErrorMessage(error) };
      }
    },
    [options],
  );

  const settleTranscription = useCallback(
    async (recording: VoiceRecording, result: TranscriptionResult) => {
      if (result.kind === "cancelled") return;
      if (result.kind === "failed") {
        if (mountedRef.current) {
          failVoiceRecording(recording.id, result.message);
        } else if (persistRecordings) {
          failVoiceRecording(recording.id, result.message);
          appToast.error("Couldn't transcribe your recording", {
            description: "It's saved in its composer so you can retry.",
          });
        } else {
          void deleteVoiceRecording(recording.id);
        }
        return;
      }
      void deleteVoiceRecording(recording.id);
      try {
        await options.onTranscript(result.text, recording.delivery);
      } catch (error) {
        appToast.error("Voice input failed", {
          description: resolveRecordingErrorMessage(error),
        });
      }
    },
    [options, persistRecordings],
  );

  const transcribeRecording = useCallback(
    async (recording: VoiceRecording) => {
      setState("transcribing");
      setDelivery(recording.delivery);
      const abortController = new AbortController();
      transcriptionAbortRef.current = abortController;
      const result = await runTranscription(
        recording,
        abortController.signal,
        options.playCompletionTransition,
      );
      if (transcriptionAbortRef.current === abortController) {
        transcriptionAbortRef.current = null;
      }
      await settleTranscription(
        recording,
        result.kind === "cancelled"
          ? { kind: "failed", message: "Transcription cancelled" }
          : result,
      );
      setState("idle");
    },
    [options, runTranscription, settleTranscription],
  );

  const start = useCallback(async () => {
    if (!isSupported) {
      showError(voiceUnsupportedMessage(unsupportedReason));
      return;
    }
    if (
      startingRef.current ||
      state === "recording" ||
      state === "transcribing"
    ) {
      return;
    }

    startingRef.current = true;
    const request = ++deviceRequestRef.current;
    try {
      const stream = await requestAudioInputStream(
        navigator.mediaDevices,
        preferredAudioInputDeviceId,
      ).catch((error: unknown) => {
        setCaptureError(
          resolveRecordingErrorMessage(
            error,
            preferredAudioInputDeviceId !== null,
          ),
        );
        throw error;
      });
      if (request !== deviceRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setCaptureError(null);
      void refreshDevices();
      recordingPreferenceRef.current = preferredAudioInputDeviceId;
      streamRef.current = stream;
      setStream(stream);
      chunksRef.current = [];
      startedAtMsRef.current = Date.now();
      promptContextRef.current = options.getPromptContext?.();
      stopIntentRef.current = "transcribe";
      acceptedRecordingPendingRef.current = false;
      shouldHoldWakeLockRef.current = true;
      requestRecordingWakeLock();

      const recordingStream =
        typeof AudioContext === "undefined"
          ? null
          : createMicrophoneRecordingStream(stream);
      recordingStreamRef.current = recordingStream;
      if (recordingStream) await recordingStream.resume();
      if (request !== deviceRequestRef.current) return;
      const recorderInput = recordingStream?.stream ?? stream;
      const preferredMimeType = resolvePreferredAudioMimeType();
      const recorder = preferredMimeType
        ? new MediaRecorder(recorderInput, { mimeType: preferredMimeType })
        : new MediaRecorder(recorderInput);
      mediaRecorderRef.current = recorder;
      const capture = beginVoiceCapture(
        {
          key: recordingKey,
          mimeType: recorder.mimeType || preferredMimeType || "audio/webm",
          promptContext: promptContextRef.current,
        },
        { persist: persistRecordings },
      );

      recorder.onstart = () => {
        setState("recording");
      };

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
          capture.append(event.data);
        }
      };

      recorder.onerror = () => {
        showError("Voice recording failed");
      };

      recorder.onstop = async () => {
        acceptedRecordingPendingRef.current = false;
        releaseRecordingWakeLock();
        stopMediaStream();
        const stopIntent = stopIntentRef.current;
        stopIntentRef.current = "transcribe";

        if (
          stopIntent === "discard" ||
          (stopIntent === "keep" && !persistRecordings)
        ) {
          capture.close();
          chunksRef.current = [];
          promptContextRef.current = undefined;
          setState("idle");
          return;
        }

        const startedAtMs = startedAtMsRef.current ?? Date.now();
        startedAtMsRef.current = null;
        const durationMs = Date.now() - startedAtMs;

        if (durationMs < MIN_RECORDING_DURATION_MS) {
          capture.close();
          showError("Recording too short (minimum 1 second)");
          chunksRef.current = [];
          promptContextRef.current = undefined;
          return;
        }

        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (chunks.length === 0) {
          capture.close();
          showError("No audio was captured");
          promptContextRef.current = undefined;
          return;
        }

        const recordedMimeType =
          recorder.mimeType || preferredMimeType || "audio/webm";
        const audioFile = new File(
          chunks,
          recordingFileName(recordedMimeType),
          {
            type: recordedMimeType,
          },
        );
        const promptContext = promptContextRef.current;
        promptContextRef.current = undefined;

        const recording = saveVoiceRecording(
          {
            key: recordingKey,
            file: audioFile,
            promptContext,
            delivery: stopIntent === "keep" ? "insert" : deliveryRef.current,
          },
          { persist: persistRecordings },
        );
        capture.close();
        if (stopIntent === "keep") {
          failVoiceRecording(
            recording.id,
            "Recording stopped before it was sent",
          );
          return;
        }
        await transcribeRecording(recording);
      };

      try {
        recorder.start(CHUNK_TIMESLICE_MS);
      } catch (error) {
        capture.close();
        throw error;
      }
    } catch (error) {
      stopMediaStream();
      mediaRecorderRef.current = null;
      chunksRef.current = [];
      startedAtMsRef.current = null;
      promptContextRef.current = undefined;
      stopIntentRef.current = "transcribe";
      acceptedRecordingPendingRef.current = false;
      transcriptionAbortRef.current = null;
      releaseRecordingWakeLock();
      showError(
        resolveRecordingErrorMessage(
          error,
          preferredAudioInputDeviceId !== null,
        ),
      );
    } finally {
      startingRef.current = false;
    }
  }, [
    isSupported,
    options,
    unsupportedReason,
    persistRecordings,
    preferredAudioInputDeviceId,
    recordingKey,
    releaseRecordingWakeLock,
    refreshDevices,
    requestRecordingWakeLock,
    showError,
    state,
    stopMediaStream,
    transcribeRecording,
  ]);

  const stop = useCallback(
    (nextDelivery: VoiceDelivery) => {
      if (state !== "recording") {
        return;
      }

      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== "recording") {
        return;
      }
      deliveryRef.current = nextDelivery;
      setDelivery(nextDelivery);
      stopIntentRef.current = "transcribe";
      acceptedRecordingPendingRef.current = true;
      try {
        recorder.stop();
      } catch (error) {
        acceptedRecordingPendingRef.current = false;
        showError(resolveRecordingErrorMessage(error));
      }
    },
    [showError, state],
  );

  const retry = useCallback(
    (recording: FailedVoiceRecording) => {
      const signal = startVoiceRecordingRetry(recording.id);
      if (!signal) return;
      void runTranscription(recording, signal, undefined).then((result) => {
        if (!finishVoiceRecordingRetry(recording.id, signal)) return;
        return settleTranscription(recording, result);
      });
    },
    [runTranscription, settleTranscription],
  );

  const discard = useCallback((recording: FailedVoiceRecording) => {
    void deleteVoiceRecording(recording.id);
  }, []);

  const download = useCallback((recording: FailedVoiceRecording) => {
    void saveFile({ blob: recording.file, fileName: recording.file.name });
  }, []);

  const cancel = useCallback(() => {
    if (state === "recording") {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === "recording") {
        stopIntentRef.current = "discard";
        acceptedRecordingPendingRef.current = false;
        try {
          recorder.stop();
        } catch (error) {
          showError(resolveRecordingErrorMessage(error));
        }
      } else {
        stopIntentRef.current = "discard";
        acceptedRecordingPendingRef.current = false;
        transcriptionAbortRef.current?.abort();
      }
      return;
    }

    if (state === "transcribing") {
      const abortController = transcriptionAbortRef.current;
      if (abortController) {
        abortController.abort();
        transcriptionAbortRef.current = null;
      }
      setState("idle");
    }
  }, [showError, state]);

  return {
    state,
    microphoneWarning:
      captureError ??
      (state === "recording" && silent
        ? "No audio detected. Check your microphone or choose another."
        : null) ??
      (hasDeviceAccess && devices.length === 0
        ? "No microphones are available. Connect a microphone or check microphone access."
        : null),
    isSupported,
    unsupportedReason,
    stream,
    isRecording: state === "recording",
    isProcessing: state === "transcribing",
    isListening: state === "recording" || state === "transcribing",
    delivery,
    failedRecordings,
    start,
    stop,
    retry,
    discard,
    download,
    cancel,
  };
}
