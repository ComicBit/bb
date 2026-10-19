// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { clear, createStore, keys } from "idb-keyval";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

type VoiceRecordingStore = typeof import("./voice-recording-store");

async function loadFreshStore(): Promise<VoiceRecordingStore> {
  vi.resetModules();
  return import("./voice-recording-store");
}

function recordingFile(contents: string): File {
  return new File([contents], "recording.webm", { type: "audio/webm" });
}

const recordingsDatabase = createStore("bb-voice-recordings", "recordings");

afterEach(() => clear(recordingsDatabase));

it("restores a recording that never finished transcribing after a reload", async () => {
  const before = await loadFreshStore();
  before.saveVoiceRecording(
    {
      key: "thread/thr_1",
      file: recordingFile("spoken audio"),
      promptContext: "earlier text",
      delivery: "send",
    },
    { persist: true },
  );
  const other = before.saveVoiceRecording(
    {
      key: "thread/thr_2",
      file: recordingFile("other audio"),
      promptContext: undefined,
      delivery: "insert",
    },
    { persist: true },
  );
  before.failVoiceRecording(other.id, "HTTP 500");
  await waitFor(async () =>
    expect(await keys(recordingsDatabase)).toHaveLength(2),
  );

  const after = await loadFreshStore();
  const { result } = renderHook(() =>
    after.useFailedVoiceRecordings("thread/thr_1"),
  );
  await waitFor(() => expect(result.current).toHaveLength(1));
  const [restored] = result.current;
  expect(restored).toMatchObject({
    key: "thread/thr_1",
    promptContext: "earlier text",
    delivery: "send",
    errorMessage: null,
  });
  expect(restored?.file.name).toBe("recording.webm");
  expect(restored?.file.type).toBe("audio/webm");
  expect(await restored?.file.text()).toBe("spoken audio");
});

it("leaves nothing stored once recordings are deleted, even before their saves finish", async () => {
  const before = await loadFreshStore();
  const transcribed = before.saveVoiceRecording(
    {
      key: "thread/thr_1",
      file: recordingFile("transcribed audio"),
      promptContext: undefined,
      delivery: "insert",
    },
    { persist: true },
  );
  void before.deleteVoiceRecording(transcribed.id);
  const discarded = before.saveVoiceRecording(
    {
      key: "thread/thr_1",
      file: recordingFile("discarded audio"),
      promptContext: undefined,
      delivery: "insert",
    },
    { persist: true },
  );
  before.failVoiceRecording(discarded.id, "Service unavailable");
  const { result } = renderHook(() =>
    before.useFailedVoiceRecordings("thread/thr_1"),
  );
  expect(result.current.map((recording) => recording.id)).toEqual([
    discarded.id,
  ]);
  await act(() => before.deleteVoiceRecording(discarded.id));
  expect(result.current).toEqual([]);
  expect(await keys(recordingsDatabase)).toEqual([]);
});

it("recovers the audio captured before a reload interrupted the recording", async () => {
  const before = await loadFreshStore();
  const capture = before.beginVoiceCapture(
    {
      key: "thread/thr_1",
      mimeType: "audio/mp4",
      promptContext: "draft so far",
    },
    { persist: true },
  );
  for (const part of ["first ", "second ", "third"]) {
    capture.append(new Blob([part], { type: "audio/mp4" }));
  }
  await waitFor(async () =>
    expect(await keys(recordingsDatabase)).toHaveLength(3),
  );

  const after = await loadFreshStore();
  const { result } = renderHook(() =>
    after.useFailedVoiceRecordings("thread/thr_1"),
  );
  await waitFor(() => expect(result.current).toHaveLength(1));
  const [recovered] = result.current;
  expect(recovered).toMatchObject({
    key: "thread/thr_1",
    promptContext: "draft so far",
    delivery: "insert",
    errorMessage: after.INTERRUPTED_CAPTURE_MESSAGE,
  });
  expect(recovered?.file.name).toBe("recording.mp4");
  expect(recovered?.file.type).toBe("audio/mp4");
  expect(await recovered?.file.text()).toBe("first second third");
  await waitFor(async () =>
    expect(await keys(recordingsDatabase)).toEqual([
      ["thread/thr_1", recovered?.id],
    ]),
  );

  const again = await loadFreshStore();
  const { result: reloaded } = renderHook(() =>
    again.useFailedVoiceRecordings("thread/thr_1"),
  );
  await waitFor(() => expect(reloaded.current).toHaveLength(1));
  expect(await reloaded.current[0]?.file.text()).toBe("first second third");
});

it("stores a finished capture once, as its recording", async () => {
  const before = await loadFreshStore();
  const capture = before.beginVoiceCapture(
    { key: "thread/thr_1", mimeType: "audio/webm", promptContext: undefined },
    { persist: true },
  );
  capture.append(new Blob(["spoken audio"], { type: "audio/webm" }));
  const saved = before.saveVoiceRecording(
    {
      key: "thread/thr_1",
      file: recordingFile("spoken audio"),
      promptContext: undefined,
      delivery: "send",
    },
    { persist: true },
  );
  capture.close();
  await waitFor(async () =>
    expect(await keys(recordingsDatabase)).toEqual([
      ["thread/thr_1", saved.id],
    ]),
  );

  const after = await loadFreshStore();
  const { result } = renderHook(() =>
    after.useFailedVoiceRecordings("thread/thr_1"),
  );
  await waitFor(() => expect(result.current).toHaveLength(1));
  expect(result.current[0]).toMatchObject({ id: saved.id, delivery: "send" });
});
