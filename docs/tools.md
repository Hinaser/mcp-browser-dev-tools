# Tools

The server exposes 36 tools. Tools that take `sessionId` work on a tab attached with `attach_tab`; call it first and reuse the returned session.

## Tool List

| Group               | Tool                                                         | What it does                                                                                                                          |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Browser and tabs    | `browser_status`                                             | Reports whether the browser endpoint answers and how many sessions are attached.                                                      |
|                     | `ensure_browser`                                             | Reuses a running browser or launches one, and can open a URL, in one call.                                                            |
|                     | `launch_browser`                                             | Launches a debug-enabled browser and can return a doctor report.                                                                      |
|                     | `list_tabs`, `new_tab`, `close_tab`                          | List, open, and close tabs.                                                                                                           |
|                     | `attach_tab`, `detach_tab`, `list_sessions`                  | Attach to a tab (buffering console and network events from then on), detach, and list sessions.                                       |
| Act                 | `navigate`, `reload`                                         | Load a URL or reload, waiting for interactive or complete load.                                                                       |
|                     | `click`, `hover`                                             | Real mouse input at the element's center; waits for the element and fails if another element still covers it.                         |
|                     | `type`                                                       | Real text input, replacing the content unless `clear` is false. Date, time, color, and range inputs get their value set directly.     |
|                     | `select`                                                     | Picks an option in a `<select>` by value or label.                                                                                    |
|                     | `press_key`                                                  | Real key presses and combinations such as `Enter` or `Shift+Tab`.                                                                     |
|                     | `scroll`, `set_viewport`                                     | Scroll the page or an element into view; override the viewport size.                                                                  |
| Wait and batch      | `wait_for`                                                   | Waits for selector state, element text, URL, ready state, or a JavaScript expression, or for the first of several outcomes (`anyOf`). |
|                     | `run_steps`                                                  | Runs up to 50 steps in one call, with `sleep`, `if`/`elseIf`/`else`, and `repeat … until`.                                            |
| Inspect             | `get_page_state`                                             | URL, title, ready state, viewport, and scroll position.                                                                               |
|                     | `get_document`, `inspect_element`                            | The DOM tree, or one element's box, visibility, role, accessible name, and styles.                                                    |
|                     | `take_screenshot`                                            | The page or one element, as base64, an image block, or a file.                                                                        |
|                     | `evaluate_js`                                                | Runs JavaScript in the page (on by default; `MCP_BROWSER_ENABLE_EVAL=0` removes it).                                                  |
| Console and network | `get_console_messages`, `get_network_requests`, `get_events` | Buffered console messages, network requests (including ones the page made before it was attached), and events.                        |
|                     | `get_har`                                                    | Buffered network activity as HAR-like JSON.                                                                                           |
| Session state       | `get_cookies`, `get_storage`                                 | Page-visible cookies and web storage.                                                                                                 |
|                     | `capture_session_snapshot`, `restore_session_snapshot`       | Save cookies and storage, and restore them later on the same origin.                                                                  |
|                     | `compare_page_state`, `compare_selector`                     | Compare two attached sessions, for example Chrome against Firefox.                                                                    |
|                     | `capture_debug_report`                                       | Page state, storage summary, recent console and network, and a screenshot in one bundle.                                              |

## Browser And Tab Tools

- `browser_status` returns broker metadata too: `serverName` and `serverVersion`
  In `auto` mode it also includes per-browser adapter status under `browsers`
  Protocol adapters may also include `attemptedEndpoint` when discovery retries or fallback probing occur
- `ensure_browser`
  Ensures a compatible browser is reachable, launches one if needed, and can open a tab for the requested URL in a single MCP call
  In `auto` mode, pass `browserFamily`
  For Chrome or Edge launches, `userDataDir` is optional; if omitted, the broker auto-creates a temporary profile when an already-running browser process makes that necessary
  When `MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS=1`, this tool also accepts `unsafeArgs` as an array of browser flags. Broker-managed launch flags such as the debug port and profile path still cannot be overridden.
- `launch_browser`
  Launches a local debug-enabled browser that matches the current broker configuration and can return an inline doctor report
  In `auto` mode, pass `browserFamily`
  For Chrome or Edge launches, `userDataDir` is optional; if omitted, the broker auto-creates a temporary profile when an already-running browser process makes that necessary
  When `MCP_BROWSER_ENABLE_UNSAFE_LAUNCH_ARGS=1`, this tool also accepts `unsafeArgs` as an array of browser flags. Broker-managed launch flags such as the debug port and profile path still cannot be overridden.
- `list_tabs`
  In `auto` mode each `targetId` is namespaced as `chromium:<id>` or `firefox:<id>`
- `new_tab`
  In `auto` mode, pass `browserFamily`
- `close_tab`
- `list_sessions`
  In `auto` mode each `sessionId` is namespaced the same way
- `attach_tab`
- `detach_tab`

`evaluate_js` runs code in the page's main world and returns the value of its last expression statement, as a browser console does. Top-level `await` works on both Chromium and Firefox, and a returned promise is awaited unless `awaitPromise` is false. On Firefox, code that uses top-level `await` runs inside an async function, so its declarations stay local to that call; on Chromium they remain for later calls, as in a console. Store a value on `window` to keep it across calls on both.

`evaluate_js` is enabled by default, as page evaluation is in most browser MCP servers. Set `MCP_BROWSER_ENABLE_EVAL=0` to remove it from the tool list. Treat that as a way to narrow the tool surface, not as a security boundary: the other tools already read page content, cookies, and storage and can navigate anywhere, and any local process that reaches the debugging port can evaluate code through the browser protocol directly. To control page-side code execution per call, use your MCP client's tool permissions.

## Locator Syntax

Interaction and inspection tools accept these locator forms:

- CSS selectors such as `#app button.primary` or `css=.modal button`
- visible-text lookup such as `text=Open settings`
- role plus accessible name such as `role=button[name="Open settings"]`
- accessible-name lookup such as `name=Open settings`

A form field's accessible name comes from `aria-label`, `aria-labelledby`, a `<label for>`, or a `<label>` wrapped around it (not counting the field's own text).

`click`, `hover`, `type`, `select`, and `press_key` with a `selector` keep retrying every 100 ms while the element is missing, for up to `timeoutMs` (default 2000, at most 30000; `0` fails at once). `click` and `hover` also retry while the element is covered by another element or outside the viewport, and `click` while it is disabled (including inside a disabled `<fieldset>`). So a late cookie banner or a button that is enabled a moment later does not need a `sleep`. A result that had to retry reports `waitedMs`. Invalid selectors and other errors fail at once, and a retry never repeats input that was already sent.

`inspect_element` returns layout and accessibility-focused metadata including bounding box, visibility flags, interactivity flags, accessible name, inferred role, and a subset of computed styles. Invalid CSS selectors now return an explicit locator error instead of a generic DOM failure.

## Screenshot Output

`take_screenshot` returns base64 image data plus metadata such as `mimeType`, `byteLength`, and `scope`. Pass `selector` to capture a single element instead of the full page.

`output` changes how the image comes back. `image` returns an MCP image content block, with only the metadata in the JSON. `file` writes the decoded image to a file and returns its `path` instead of base64 data; passing `path` implies `file`. `path` must be absolute and end in `.png`, `.jpg`, `.jpeg`, or `.webp` (not `.webp` on Firefox), which also sets the format; missing parent directories are created. An existing file is only replaced with `overwrite: true`, and a symlink at `path` is replaced rather than written through. Without `path`, the image goes to a new private directory under the system temp directory. Files are created readable only by the current user. Without `output` or `path`, `take_screenshot` returns base64 data as before.

## Batched Steps

`run_steps` runs several session tools in order in one call, so an action and the check of its result take one round trip instead of several:

```json
{
  "sessionId": "chromium:session-1",
  "steps": [
    { "tool": "click", "arguments": { "selector": "text=Save" } },
    { "tool": "sleep", "arguments": { "ms": 300 } },
    { "tool": "take_screenshot" }
  ]
}
```

Any tool that takes `sessionId` can be a step, with its arguments minus `sessionId`, plus `sleep` (`ms`, at most 30000). Up to 50 steps are validated before any of them runs. A step fails when its tool throws or reports `found: false` for a missing element (`inspect_element` excepted, since it may be checking that an element is gone). The call stops at the first failing step unless `continueOnError` is true, and reports each step's result or error. When any step fails, the result also has a `page` field with the current URL, title, and up to 40 visible controls (role, name, value or checked state, and a `locator` to use in the next call), so the batch can be fixed without another look at the page. Password fields are listed without their value. Screenshots come back as image content blocks instead of base64 text; the step result keeps the metadata and an `image` field with the 1-based position of its image.

An `if` step branches on the page state without a round trip back to the client:

```json
{
  "tool": "if",
  "arguments": {
    "condition": { "selector": "#status", "textIncludes": "failed" },
    "then": [{ "tool": "click", "arguments": { "selector": "text=Retry" } }],
    "elseIf": [
      {
        "condition": { "urlIncludes": "/login" },
        "then": [
          { "tool": "take_screenshot", "arguments": { "output": "image" } }
        ]
      }
    ],
    "else": [{ "tool": "get_page_state" }]
  }
}
```

Each condition takes the same fields as `wait_for` (`selector` with `state`, `textEquals`, `textIncludes`, `textExcludes`, plus `url`, `urlIncludes`, `readyState`, and `expression`), and all given fields must hold. Instead of those fields, a condition can give `anyOf`, a list of such conditions of which any one must hold; the observed state then reports `matchedIndex` and what each alternative saw. `condition` and then each `elseIf` entry are checked in order, once and without waiting, and the first one that holds runs its `then`; `else` runs when none does. Put a `wait_for` or `sleep` step first if the page may still be changing. Every branch is validated up front, the 50-step limit counts steps inside branches, and an `if` placed inside a branch nests at most 4 levels deep. The `if` result reports the `branch` taken (`then`, `elseIf[i]`, or `else`), each condition it `checked` with what was observed (URL, whether the element was found and visible, its text), and the branch's step results; a failing step inside a branch fails the `if` and stops the batch like any other step.

A `repeat` step retries or polls without a round trip per attempt:

```json
{
  "tool": "repeat",
  "arguments": {
    "max": 5,
    "steps": [
      { "tool": "click", "arguments": { "selector": "text=Load more" } },
      {
        "tool": "wait_for",
        "arguments": { "selector": "#list", "textExcludes": "Loading" }
      }
    ],
    "until": { "selector": "text=Order #1042", "state": "present" }
  }
}
```

It runs `steps`, then checks `until` once without waiting, and runs the steps again until it holds, at most `max` passes (default 5, at most 10). End the steps with a `wait_for` so the page has settled before `until` is checked. The step fails if `until` still does not hold after the last pass. A failing step inside it always ends the loop, so a failed action is not retried, and stops the batch unless `continueOnError` is true. Its result reports whether `until` `matched`, how many `passes` ran, and each pass's step results and `until` observation. Its steps are validated up front and count once toward the 50-step limit, and `if` and `repeat` together nest at most 4 levels deep.

`wait_for` takes `anyOf` as well, so a wait can end on the first of several outcomes, for example `{ "anyOf": [{ "selector": "#status", "textIncludes": "Paid" }, { "selector": "#status", "textIncludes": "Declined" }] }`; its result reports `matchedIndex`. `anyOf` replaces the other condition fields rather than adding to them, and cannot be nested.

A condition can also give `expression`, JavaScript evaluated in the page's main world, which holds when its result is truthy; a returned promise is awaited first. For example, `{ "expression": "document.querySelectorAll('.row').length >= 20" }` waits for a list to fill, and `{ "expression": "window.appReady === true" }` waits for an app's own readiness flag. An expression that throws fails the wait or step at once with the error instead of waiting out the timeout, so use optional chaining (`?.`) where an element may not exist yet. Each evaluation must settle within the wait's remaining time, or within 5000ms in `if` and `repeat`. Like `evaluate_js`, `expression` is removed from every condition when `MCP_BROWSER_ENABLE_EVAL=0`.

Text conditions compare the element's full visible text with whitespace collapsed; `textExcludes` never holds for a missing element. The text reported back in results is clipped to 400 characters.

## Session State And Network

- `get_cookies` returns bounded page-visible cookies from the attached page context
- `get_storage` returns bounded `localStorage` and `sessionStorage` entries and can filter to one storage area
- `capture_debug_report` bundles page state, cookie/storage summaries, recent console messages, recent network requests, and an optional screenshot
- `capture_session_snapshot` exports bounded page-visible cookies plus local and session storage for later reuse
- `restore_session_snapshot` restores a captured snapshot onto the current origin and can optionally clear storage first
- `get_har` exports buffered network activity in a bounded HAR-like JSON structure
- `compare_page_state` and `compare_selector` compare bounded state across two attached sessions, which is especially useful in `auto` mode

## Debugging Notes

- `attach_tab` now seeds network history from the Performance API so already-loaded pages still show useful requests
- console buffers include source URL, line and column where the browser reports them, plus stack frames when available
- `get_page_state` reports the current URL, title, viewport, and scroll position without enabling `evaluate_js`
- broker diagnostics write to `stderr` so `stdout` stays reserved for MCP protocol traffic
