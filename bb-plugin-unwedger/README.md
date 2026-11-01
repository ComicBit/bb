# bb-plugin-unwedger

A BB plugin that adds an **Unwedge this thread** button to the regular message composer. The action always targets the composer’s own thread; it never asks you to choose one.

Clicking the button checks that thread is still failed and asks BB to retry its latest failed turn. BB's native retry guard refuses a stale recovery instead of interrupting newly resumed work and reports whether the retry started or was queued. The plugin never stops a thread.

## Build and install

```sh
npm install
bb plugin build
bb plugin install .
```

After source changes, run `bb plugin build` and `bb plugin reload unwedger`.
