# bb-plugin-unwedger

A BB plugin that adds an **Unwedge this thread** button to the regular message composer. The action always targets the composer’s own thread; it never asks you to choose one.

Clicking the button checks that thread is still failed, stops its current work, and retries its latest failed turn. BB reports whether the retry started or was queued. If the thread is no longer failed, recovery is refused without stopping it.

## Build and install

```sh
npm install
bb plugin build
bb plugin install .
```

After source changes, run `bb plugin build` and `bb plugin reload unwedger`.
