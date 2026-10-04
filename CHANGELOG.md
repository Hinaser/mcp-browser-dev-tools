# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this file starts tracking
changes from the point it was introduced rather than reconstructing older
release history retroactively.

## [Unreleased]

### Added

- `get_snapshot` lists the page's visible headings and controls, one line each with a ref such as `e12`, and every tool accepts `ref=e12` as its selector. It is the cheapest way to see what a page offers before acting, replacing `get_document` or a screenshot in most cases. Refs belong to the document that issued them, and a new document continues the numbering, so a stale or unknown ref fails with an error that says to take a new snapshot instead of naming another element. `run_steps` failure reports include a `ref` for each control
- `click`, `hover`, `type`, `select`, and `press_key` return `changes`, what the action changed on the page: headings and controls added, removed, or updated, as `get_snapshot` lines with refs; text the action added, such as an error message or a toast; URL and title changes; console errors, uncaught exceptions, and dialogs; and, when the action loaded a new document, that document's snapshot. They first wait for the page to settle: until the DOM is quiet for 150 ms and the document, fetch, and XHR requests the action started have finished, for at most 2 s; after a navigation, until the new document is quiet and its own fetches are done, for at most 10 s. A `run_steps` batch containing these tools reports one `changes` for the whole batch. The wait also covers timers of 50 ms to 1 s the action sets, so a redirect a moment after a sign-in message, or search results behind a debounce, arrive in `changes`; timer loops (a timer set from a timer callback, or whose handler already ran) are not waited for, and the page's `setTimeout` is wrapped only while an action is tracked. Text that only repeats the controls inside it, such as a list item around a link, is left out of `text` The server instructions and tool descriptions now present `changes` as the usual check after acting
- `get_snapshot` marks a filled password field `filled`, still without its value
- Headings (`h1` to `h6`) now have the inferred role `heading`, so `role=heading` locators and `inspect_element` report them

- `click` and `hover` take viewport coordinates, `x` and `y`, instead of a selector, and report the element found there with a ref. `click` takes `button` (`left`, `middle`, `right`) and `clickCount` for right, middle, double, and triple clicks
- `drag` presses on an element or point, moves in steps, and releases on another. HTML5 drag and drop works: Chromium hands the drag over to the server, which finishes it with drag events; on Firefox, which does not finish such a drag, it is dispatched from the page with a shared `DataTransfer`
- `upload_file` sets files on a file input (or its label, or an element holding one) and fires `input` and `change`; on Chromium it also takes the file chooser a button opens from script. Files can come only from the server's working directory, the system temp directory, and the new `MCP_BROWSER_UPLOAD_DIRS`, compared after resolving symlinks. Snapshots show a file input as `file` with its file names
- `set_network` blocks or mocks requests by URL glob, adds request headers, and emulates offline and slow networks (throttling on Chromium only), reporting each rule's hits. Chromium pauses only matching requests through the Fetch domain; Firefox intercepts the tab's requests with `network.addIntercept` while rules or headers are set
- `scroll` with `x` and `y`, or with a `selector` and deltas, sends a real mouse wheel there, so it can scroll a list or map inside the page
- `take_screenshot` reports the image's `width` and `height`, `cssRect`, the viewport area it shows, and `scale`, image pixels per CSS pixel, so a point seen in the image converts to `click` coordinates

### Changed

- The tool definitions are trimmed from 36.0k to 22.1k characters and the server instructions from 1.9k to 1.4k, which every model turn pays for. Descriptions say once what they repeated (locators, sessionId, timeouts, coordinates now live in the server instructions or a short line), `run_steps` and `run_tabs` keep one compact example each and no longer list every step tool, and the advertised schemas leave out `additionalProperties: false`; calls are still validated against the full schemas. A test holds the definitions to 22.5k characters

### Fixed

- Firefox sessions record requests that fail (`network.fetchError`), so `get_network_requests` and `get_har` report them as failed instead of unfinished
- Firefox network requests carry a `resourceType` (`Document`, `Fetch`, `XHR`, or the request's destination) where Firefox reports one, instead of none

## [0.2.2] - 2026-10-01

This release makes `click`, `type`, and `press_key` fail with an error
instead of reporting success when the browser never delivers their input.

### Fixed

- `click`, `type`, and `press_key` no longer report success for input the browser dropped. In the benchmark, Chrome sometimes acknowledged every click and key press to a tab after a login redirect without delivering any of them, so clicks on checkboxes and a Save button returned `clicked: true` while nothing changed. The server now counts trusted input events in each page from the start of the document, and the tools check that their input arrived; if it did not, they bring the tab to the front (Chromium) and send it once more, reporting `resent: true`, and otherwise fail with an error that says the input had no effect. On a page already loaded when the tab was attached, where page listeners could hide input from the count, a failure is reported without sending the input again

### Changed

- `click` returns the element's state after the click, so a checkbox's `checked` is its new value rather than the value before the click

## [0.2.1] - 2026-09-30

This release makes the tool definitions sent on every model turn about 30%
shorter, and explains `run_tabs` in the README.

### Changed

- The tool definitions are about 30% shorter (31.6k characters instead of 45.6k): the locator syntax is described once in the server instructions instead of in every tool that takes a selector, fields repeated inside `wait_for`'s `anyOf` and `run_tabs`'s steps no longer repeat their descriptions, and long descriptions are tighter. In the benchmark this saves about 4k input tokens per model turn, with no change in how agents use the tools
- The server instructions suggest `run_tabs` with `read_text` for reading several pages
- The README explains `run_tabs` with a diagram and an example, and the `run_tabs` example in `docs/tools.md` now gives `browserFamily`, which the default `auto` mode needs for tabs opened by URL

## [0.2.0] - 2026-09-30

This release lets an agent work in several tabs at once and read their
text, end waits on the outcome that actually happens, and retry inside a
batch, so browser tasks need fewer model turns.

### Added

- `run_tabs` runs step lists in several tabs at the same time (up to 8, all at once unless `concurrency` is lower), opening a tab for each URL and closing it afterwards unless `keepTabs` is true, and returns every tab's results in one reply; a failing or timed-out tab does not stop the others
- `read_text` returns the readable text of the page's main content or of one element, as plain lines up to `maxChars`, and with `links` the links inside it
- `run_steps` accepts a `repeat` step (`steps`, `until`, `max`) that runs its steps, checks `until` once, and repeats until it holds, at most `max` passes (default 5, at most 10), so retry and polling flows need no round trip per attempt
- `wait_for` and `run_steps` conditions accept `anyOf` to hold when any one of several conditions holds, reporting `matchedIndex`, and `textExcludes` to hold once a selector's text no longer contains a string
- `click`, `hover`, `type`, `select`, and `press_key` (with `selector`) retry while their element is missing, for up to `timeoutMs` (default 2000; `0` fails at once), and report `waitedMs` when they retried; `click` and `hover` also retry while it is covered or outside the viewport, and `click` while it is disabled
- `wait_for` and `run_steps` conditions accept `expression`, JavaScript that holds when its result (awaited if it is a promise) is truthy; an expression that throws fails at once with the error, and the field is left out when `MCP_BROWSER_ENABLE_EVAL=0`
- A failed `run_steps` batch returns a `page` field with the URL, title, and up to 40 visible controls, each with a locator the tools accept
- The benchmark can run GPT models through the Codex CLI and gains a `research` scenario that reads five slow pages from a results list; `PERFORMANCE.md` compares seven models

### Changed

- `click` on a disabled element (including one inside a disabled `<fieldset>`) now fails after its `timeoutMs` instead of sending a click that does nothing, and `inspect_element` reports such elements as disabled
- Form fields wrapped in a `<label>` take their accessible name from that label, so `role=` and `name=` locators find them by label text, and a password field never uses its value as its accessible name
- `name=` locators that match a `<label>` resolve to the control it labels when that control is visible, so `name=Username` types into the field instead of failing on its label
- Text conditions (`textEquals`, `textIncludes`, `textExcludes`) compare the element's full visible text in the page instead of the first 400 characters, so they work on long elements such as `body`; results still report text clipped to 400 characters

### Fixed

- On Chromium, closing a tab while `navigate` or `reload` waited for it to load no longer ends the server with an unhandled promise rejection
- On Chromium, `evaluate_js` awaits a promise the expression returns, as `awaitPromise` describes, instead of returning `{}`; a rejected promise is reported in `exceptionDetails`, and a thrown error leaves `result` null as on Firefox
- On Firefox, `evaluate_js` accepts top-level `await`, as it already did on Chromium: such code runs inside an async function that returns the value of its last expression statement
- With `MCP_BROWSER_FAMILY=auto` (the default), `evaluate_js` passes its `awaitPromise` and `returnByValue` options to the browser instead of dropping them
- On Chromium, an error thrown inside a page action (for example "No matching <option> found" from `select`) is reported with its message instead of "Uncaught"

## [0.1.0] - 2026-09-30

This release lets an agent act on a page and check the result in one tool
call, and turns `evaluate_js` on by default.

### Added

- `run_steps` MCP tool that runs several session tools (plus `sleep`) in order on one attached session in a single call, validates every step up front, stops at the first failure unless `continueOnError` is set, and returns screenshots as image content. An `if` step branches on page conditions checked once (the `wait_for` condition fields), with a flat `elseIf` list and `else`
- `wait_for` accepts `textEquals` and `textIncludes` to wait for a selector's visible text
- `MCP_BROWSER_TIMING_LOG` writes one JSON line per tool call with its duration, outcome, and response size
- A benchmark in `bench/` that measures agent task time, turns, and cost on fixed scenarios, with the method and results in `PERFORMANCE.md`

### Changed

- `evaluate_js` is now enabled by default, matching most browser MCP servers; set `MCP_BROWSER_ENABLE_EVAL=0` (or `false`) to turn it off. Existing `MCP_BROWSER_ENABLE_EVAL=1` configurations keep working
- `take_screenshot` accepts `output`: `image` returns the screenshot as image content instead of base64 text, and `file` (implied by `path`) writes it to an image file (absolute path with an image extension, or a new private temp file, created readable only by the current user) and returns the path; it does not replace an existing file unless `overwrite` is true. Without these arguments it returns base64 data as before
- The server instructions recommend `run_steps` with an example call, and `click`, `type`, `select`, and `press_key` point to it for checking their result in the same call

## [0.0.6] - 2026-09-27

This stable release rolls up the `0.0.6-beta.0` and `0.0.6-beta.1`
prerelease changes below with no further changes.

## [0.0.6-beta.1] - 2026-09-27

### Added

- `MCP_BROWSER_USER_DATA_DIR` sets the browser profile that `ensure_browser` and `launch_browser` use when they have to launch a browser

### Changed

- `launch_browser` reuses an already reachable browser (returning `reused: true`, and opening `url` in a new tab) instead of launching another one, unless `port`, `address`, `userDataDir`, or `unsafeArgs` is passed
- `ensure_browser` and `launch_browser` check the browser status three times before deciding to launch, handle launches one at a time, and do not launch the same browser again for 30 seconds while a browser they launched has not yet answered, so parallel or repeated calls cannot each start a browser
- On macOS and Linux, launching on a profile that is already open (or Firefox without a profile while Firefox is running) no longer opens another window in that browser: the broker waits for its endpoint instead, and fails with an explanation if the endpoint stays down
- `open` reports when it reused an already running browser instead of launching one

### Fixed

- `ensure_browser` in `auto` mode now finds an Edge or Chrome browser reachable through the Chromium adapter when asked for `edge`, instead of launching another browser or failing to open the tab

## [0.0.6-beta.0] - 2026-09-27

### Changed

- `click`, `hover`, `type`, and `press_key` now send trusted browser input (CDP `Input.*` on Chromium, WebDriver BiDi `input.performActions` on Firefox) instead of synthetic DOM events, so React `onChange`, form submission on Enter, focus movement on Tab, pointer-event-driven menus, CSS `:hover`, and `beforeinput`-based rich-text editors respond as they do to a person
- `click` and `hover` now fail with the covering element's description when another element (a modal, cookie banner, or overlay) sits on top of the target, instead of silently invoking the hidden element
- `press_key` accepts key combinations such as `Shift+Tab`, `Control+Enter`, and `Meta+a`, and rejects unknown key names instead of dispatching them silently
- `type` sets date, time, color, and range inputs through the native value setter so React state updates
- Every tool parameter now has a description, including the locator grammar for `selector` (matching rules, case sensitivity, and the iframe/shadow-root limit), defaults for optional parameters, and side effects such as automatic dialog handling on `click`/`press_key` and scrolling in `inspect_element`/`wait_for`

## [0.0.5] - 2026-03-14

### Added

- `MCP_BROWSER_LOG_FILE` environment variable to write all log output to a file in addition to stderr, useful for diagnosing crashes when the MCP client captures stderr inconsistently

## [0.0.4] - 2026-03-14

### Added

- Auto-dismiss JavaScript dialogs (`alert`, `confirm`, `prompt`) on attached CDP and Firefox BiDi sessions to prevent page-blocking modals from stalling the broker connection and causing MCP clients to deregister all tools
- Dialog events are captured in the session event buffer as `kind: "dialog"` entries so callers can observe that a dialog appeared even though it was auto-dismissed
- Firefox BiDi sessions now subscribe to `browsingContext.userPromptOpened` and `browsingContext.userPromptClosed` events
- Crash diagnostics: `uncaughtException` and `unhandledRejection` handlers log full stack traces to stderr before exit, and a `process.exit` handler logs non-zero exit codes — all with `force: true` so they appear regardless of the configured log level

## [0.0.3] - 2026-03-12

### Added

- `MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS=1` to expose an `unsafeArgs` array on `launch_browser` and `ensure_browser` for opt-in browser flag passthrough without allowing broker-managed launch flags to be overridden

### Changed

- remove the npm beta badge from the README header now that the stable release line is current

## [0.0.2] - 2026-03-11

This stable release rolls up the `0.0.2-beta.0` and `0.0.2-beta.1`
prerelease changes below and adds the following final changes.

### Added

- `get_cookies` and `get_storage` MCP tools for bounded session-scoped cookie and storage inspection
- `capture_debug_report` for one-shot page state, storage summary, console, network, and screenshot capture
- `get_har` for bounded HAR-like exports from buffered session network activity
- `compare_page_state` and `compare_selector` for bounded cross-session and cross-browser checks
- `capture_session_snapshot` and `restore_session_snapshot` for bounded same-origin cookie and storage restore workflows
- loopback auto-discovery for default CDP and Firefox BiDi endpoints across ports `9222` through `9226`
- `launch_browser` MCP tool so agents can start a compatible local debug-enabled browser through the broker
- `ensure_browser` MCP tool so agents can make browser startup and initial tab creation a single workflow step
- `serve --bootstrap-wsl-relay` so a WSL broker can start the Windows-side CDP relay automatically before adapter startup

### Changed

- `MCP_BROWSER_FAMILY` now defaults to `auto` so agents can choose the browser family at runtime instead of starting in Chromium-only mode
- Chromium-family launches now auto-create a temporary profile when an already-running browser process would otherwise swallow the new debug flags

## [0.0.2-beta.1] - 2026-03-11

### Changed

- add npm version, beta, and download badges to the README header

## [0.0.2-beta.0] - 2026-03-11

### Added

- `new_tab` and `close_tab` MCP tools for browser tab lifecycle management
- `wait_for` MCP tool for selector, URL, and ready-state waits on attached sessions
- MIT `LICENSE` file and package license metadata
- changelog tracking for future releases
- `MCP_BROWSER_LOG_LEVEL` and `MCP_BROWSER_DEBUG_STDIO` for stderr-only broker diagnostics
