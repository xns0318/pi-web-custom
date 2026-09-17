# Workspace Terminals

The Explorer terminal action opens or focuses a terminal for its selected cwd
in the right panel's existing tab bar. It keeps the active matching tab, or focuses
the last matching tab when another workspace or file is active.

Use **+ New terminal** in a terminal's header to create an additional independent
shell in that tab's original cwd, even when another project is selected in the
Explorer. This never replaces or reconnects to the existing shell. Multiple tabs
for the same directory have separate processes, output, working directories and
shell variables. They still share the host filesystem, login-shell configuration
and the server's baseline environment; this is not container isolation.

Tabs have stable per-directory numbers (for example, `1: repo` and `2: repo`).
Closing a tab does not renumber its siblings; its number may be reused by a new
tab. Restart replaces only that tab's process and keeps its number.

Each terminal tab keeps the cwd it was created with. Files still mount only their
active viewer; terminal panels stay mounted behind inactive tabs, hidden panels,
and session or project switches.

## Lifecycle

- Each new tab generates a random terminal ID before creation. Creation with
  the same ID and cwd is idempotent, including React Strict Mode's repeated
  effects. An existing ID cannot be reused for another cwd.
- `sessionStorage` retains terminal IDs, cwds, numbers, and the active terminal
  layout across refresh. Tabs are deduplicated by ID, never by cwd. Older saved
  tabs without numbers are assigned labels without changing their process IDs.
  Restored tabs first check the existing server instance and never silently start
  replacement processes after expiry or server restart.
- A new PTY gets a 120-second connection lease. Subscribing cancels expiry;
  the last subscriber leaving starts a new 120-second grace period. This also
  collects creations that never establish their initial connection.
- Hiding a panel, switching tabs, and unmounting a component only disconnect
  clients. Explicitly terminating a tab waits for creation and in-flight input
  before deleting the PTY. Restart waits for termination before creating a new
  ID. Failed termination leaves the tab available to retry.
- A shell exit closes the SSE stream and retains its output and exit code in
  the browser. Unobserved server records expire after the same grace period.
- Explicit termination and expiry signal the shell, escalating to SIGKILL after
  two seconds if it ignores SIGHUP. Server shutdown force-kills shells immediately.

## Transport

Output events carry a monotonically increasing UTF-16 offset in SSE `id`.
Reconnections use `Last-Event-ID` (or `after` on an explicit reconnect) and send
only the missing suffix. The server keeps at most 128 KiB of UTF-16 code units;
an older cursor triggers a terminal reset and bounded history replay. This is
bounded output history, not a serialized full-screen terminal snapshot. Slow
SSE consumers are disconnected once their response queue fills.

Input and resizes are serialized. Pending adjacent input is batched so remote
connections do not require one round trip per keystroke; large pastes are split
without splitting Unicode characters. Failed input is not retried because its
delivery may be ambiguous. Reconnect attaches to the same process with a fresh
writer; restart explicitly replaces the process.

`bin/prepare-terminal.js` repairs node-pty 1.1.0's macOS spawn-helper executable
bits during installation, including published/npm-installed Pi Web packages.

Pi Web pins node-pty to `1.2.0-beta.15`, which includes Linux x64 and ARM64
prebuilt binaries. Native module loading is deferred until terminal creation,
so missing or incompatible binaries produce a JSON error with repair instructions.
Empty or non-JSON API errors show the HTTP status and direct users to the server log.

If a native binary cannot load, run
`npm rebuild node-pty --build-from-source --ignore-scripts=false --foreground-scripts` from the
installation directory (for npx, the cache directory containing `node_modules`).
On Debian/Ubuntu, install `python3` and `build-essential` first. This forces a
source build instead of reusing a missing or incompatible prebuilt binary.
Restart Pi Web after repair.

## Verification

Run `npm test` for native PTY, lease, output cursor, input queue, and storage
checks. `npm run test:terminal` starts an isolated development server and runs
desktop/mobile browser checks using generated session fixtures. Install the
Playwright Chromium browser first with `npx playwright install chromium`.
The browser check prints the temporary location of its screenshots and log.
