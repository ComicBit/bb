Retry a failed BB thread directly from that thread's message composer.

## What it does

- Adds an **Unwedge this thread** button to regular thread composers.
- Uses the composer’s own thread ID; it never asks you to choose a thread.
- Checks that the current thread is still failed, stops its current work, and retries its latest failed turn.
- Reports whether the retry started or was queued.

The plugin reads thread status through BB's plugin SDK. It stores no thread contents and contacts no external service.
