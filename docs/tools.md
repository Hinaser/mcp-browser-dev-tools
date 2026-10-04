# Tools

The server has 44 tools and lists the 24 of the core set by default, plus `more_tools`, which lists, describes, and calls the others (see [Tool Sets](#tool-sets)). Tools that take `sessionId` work on a tab attached with `attach_tab`; call it first and reuse the returned session.

## Tool Sets

Every model turn sends the definitions of every tool the server lists, so it lists only the core set unless told otherwise. The other tools are still there, without their definitions costing every turn:

- `more_tools` without arguments lists them, one line each with its group and first sentence; with `name`, it returns that tool's description and arguments; with `name` and `arguments`, it calls the tool, checking the arguments as a direct call would, and returns its result and `changes`.
- `run_steps` and `run_tabs` steps can use every tool that takes `sessionId`, listed or not, for example `{"tool":"set_network","arguments":{"offline":true}}`.
- Calling an unlisted tool directly fails with an error that says how to reach it.

Set `MCP_BROWSER_TOOLS` to `all`, or to a comma-separated list of groups and tool names to add to the list, for example `MCP_BROWSER_TOOLS=network,drag`, for tools an agent uses often enough to be worth their definitions; with every tool listed, `more_tools` is left out. An unknown name stops the server at startup. The setting chooses what is listed, not what can run: `MCP_BROWSER_ENABLE_EVAL=0` still removes `evaluate_js` everywhere.

| Group            | Tools                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core` (default) | `ensure_browser`, `list_tabs`, `new_tab`, `close_tab`, `attach_tab`, `navigate`, `reload`, `click`, `hover`, `type`, `select`, `press_key`, `scroll`, `upload_file`, `wait_for`, `run_steps`, `run_tabs`, `get_snapshot`, `read_text`, `inspect_element`, `take_screenshot`, `evaluate_js`, `get_console_messages`, `get_network_requests` |
| `input`          | `drag`, `set_viewport`                                                                                                                                                                                                                                                                                                                     |
| `network`        | `set_network`, `get_har`, `get_events`                                                                                                                                                                                                                                                                                                     |
| `state`          | `get_cookies`, `get_storage`, `capture_session_snapshot`, `restore_session_snapshot`, `capture_debug_report`, `get_page_state`, `get_document`                                                                                                                                                                                             |
| `compare`        | `compare_page_state`, `compare_selector`                                                                                                                                                                                                                                                                                                   |
| `browser`        | `browser_status`, `launch_browser`, `list_sessions`, `detach_tab`                                                                                                                                                                                                                                                                          |
| `performance`    | `get_performance`, `record_trace`                                                                                                                                                                                                                                                                                                          |

## Tool List

| Group               | Tool                                                         | What it does                                                                                                                          |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Browser and tabs    | `browser_status`                                             | Reports whether the browser endpoint answers and how many sessions are attached.                                                      |
|                     | `ensure_browser`                                             | Reuses a running browser or launches one, and can open a URL, in one call.                                                            |
|                     | `launch_browser`                                             | Launches a debug-enabled browser and can return a doctor report.                                                                      |
|                     | `list_tabs`, `new_tab`, `close_tab`                          | List, open, and close tabs.                                                                                                           |
|                     | `attach_tab`, `detach_tab`, `list_sessions`                  | Attach to a tab (buffering console and network events from then on), detach, and list sessions.                                       |
| Act                 | `navigate`, `reload`                                         | Load a URL or reload, waiting for interactive or complete load.                                                                       |
|                     | `click`, `hover`                                             | Real mouse input at the element's center or at `x`, `y`; any button, double clicks; waits for a covered element.                      |
|                     | `drag`                                                       | Press, move in steps, and release, between elements or points; handles HTML5 drag and drop.                                           |
|                     | `type`                                                       | Real text input, replacing the content unless `clear` is false. Date, time, color, and range inputs get their value set directly.     |
|                     | `select`                                                     | Picks an option in a `<select>` by value or label.                                                                                    |
|                     | `upload_file`                                                | Sets files on a file input, or the chooser a button opens (Chromium), from allowed directories.                                       |
|                     | `press_key`                                                  | Real key presses and combinations such as `Enter` or `Shift+Tab`.                                                                     |
|                     | `scroll`, `set_viewport`                                     | Scroll the page, an element into view, or with a real wheel at a point; override the viewport size.                                   |
| Wait and batch      | `wait_for`                                                   | Waits for selector state, element text, URL, ready state, or a JavaScript expression, or for the first of several outcomes (`anyOf`). |
|                     | `run_steps`                                                  | Runs up to 50 steps in one call, with `sleep`, `if`/`elseIf`/`else`, and `repeat … until`.                                            |
|                     | `run_tabs`                                                   | Runs step lists in up to 8 tabs at once, opening tabs for URLs, and returns every tab's results together.                             |
| Inspect             | `get_page_state`                                             | URL, title, ready state, viewport, and scroll position.                                                                               |
|                     | `get_snapshot`                                               | The visible headings and controls, one line each with a ref (`e12`) that any tool accepts as `ref=e12`.                               |
|                     | `get_document`, `inspect_element`                            | The DOM tree, or one element's box, visibility, role, accessible name, and styles.                                                    |
|                     | `read_text`                                                  | The readable text of the page's main content or one element, and optionally its links.                                                |
|                     | `take_screenshot`                                            | The page or one element, as base64, an image block, or a file.                                                                        |
|                     | `evaluate_js`                                                | Runs JavaScript in the page (on by default; `MCP_BROWSER_ENABLE_EVAL=0` removes it).                                                  |
| Console and network | `get_console_messages`, `get_network_requests`, `get_events` | Buffered console messages, network requests (including ones the page made before it was attached), and events.                        |
|                     | `set_network`                                                | Blocks or mocks requests by URL pattern, adds request headers, or emulates offline and slow networks.                                 |
| Performance         | `get_performance`                                            | Load timing, rated Web Vitals, long tasks, slowest resources, and Chromium's counters.                                                |
|                     | `record_trace`                                               | Records a Chromium trace to a file DevTools' Performance panel opens.                                                                 |
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

- a ref from `get_snapshot` such as `ref=e12`
- CSS selectors such as `#app button.primary` or `css=.modal button`
- visible-text lookup such as `text=Open settings`
- role plus accessible name such as `role=button[name="Open settings"]`
- accessible-name lookup such as `name=Open settings`

`get_snapshot` is the cheapest way to see what a page offers. It lists the visible headings and controls in document order, one line each: the ref, the role (`h1` to `h6` for headings), the accessible name, and `value="…"`, `checked` or `unchecked`, and `disabled` where they apply, for example `e3 textbox "Email" value="ada@example.com"`. Pass `ref=e3` as the `selector` of any tool. An element keeps its ref across snapshots. Refs belong to the document that issued them: a new document gets new refs that continue the numbering, so an old ref never names a new element, and a document restored from the back/forward cache keeps its refs, which still name the same elements; a ref the page does not know, or whose element left the document, fails with an error that says to take a new snapshot. `limit` (default 100, at most 500) caps the lines and `more` counts the rest; `selector` restricts the snapshot to one element's subtree, and `headings: false` leaves headings out. Password fields never show their value; a filled one shows `filled`. Called directly, the lines come back as plain text; as a `run_steps` step, they are the `nodes` array.

Controls inside iframes, same-origin or cross-origin and nested, follow the top page's in the snapshot: each frame with controls gets a header line with its key, title, and URL, and its lines carry refs such as `f1e3`, element `e3` of frame `f1`:

```text
f1 frame "Card details" https://payments.example/card
f1e1 textbox "Card number" value=""
f1e2 button "Pay"
```

Any tool takes such a ref as its `selector`: the server runs the tool's page work inside that frame and moves the points it reports into the top page's viewport, so clicks, typing, hover, drag, element screenshots, `wait_for`, and `read_text` work across frames. An action on a frame element reports the frame's `changes`, with frame refs, and so does a `run_steps` batch whose actions all name elements of the same frame. A frame key lasts while its frame exists; a key from a frame that has gone fails with an error that says to take a new snapshot. CSS, `text=`, `role=`, and `name=` locators still search only the top document, and `get_snapshot` with a `selector` lists only inside that element. Up to 10 frames are listed; frames without a box (hidden) and frames with no headings or controls are left out. On Firefox, input for a frame element is sent to the frame's own browsing context, since Firefox does not route input sent to the top page into a cross-origin frame; for the same reason a Firefox `drag` must start and end in the same document. Frames scaled or rotated with a CSS `transform` are not supported: points are moved by the frame's position only.

A form field's accessible name comes from `aria-label`, `aria-labelledby`, a `<label for>`, or a `<label>` wrapped around it (not counting the field's own text).

`click`, `hover`, `drag`, `type`, `select`, and `press_key` with a `selector` keep retrying every 100 ms while the element is missing, for up to `timeoutMs` (default 2000, at most 30000; `0` fails at once). `click` and `hover` also retry while the element is covered by another element or outside the viewport, and `click` while it is disabled (including inside a disabled `<fieldset>`). So a late cookie banner or a button that is enabled a moment later does not need a `sleep`. A result that had to retry reports `waitedMs`. Invalid selectors and other errors fail at once, and a retry never repeats input that was already sent.

`click`, `type`, and `press_key` also check that their input reached the page, because a browser can acknowledge input it never delivers: Chrome has been seen doing this for every click and key press to a tab after a navigation. The server counts trusted pointer and keyboard events in the page from the moment each document starts, before page scripts can stop them. If none arrive, the tool brings the tab to the front (Chromium only) and sends the input once more, reporting `resent: true` when that works, and otherwise fails with an error rather than reporting success. On a page that was already loaded when the tab was attached, the count starts at attach, so page listeners added earlier could hide input; there the tool reports the failure without sending the input again, so an action is never repeated. Input aimed at an iframe, and a click that navigates away before the check, are reported as sent. `click` returns the element as it is after the click, so a checkbox's `checked` is its new state.

`inspect_element` returns layout and accessibility-focused metadata including bounding box, visibility flags, interactivity flags, accessible name, inferred role, and a subset of computed styles. Invalid CSS selectors now return an explicit locator error instead of a generic DOM failure.

## Pointer Input

`click`, `hover`, and `drag` take a locator or viewport coordinates: `x` and `y` in CSS pixels from the top-left corner of the viewport, the coordinates the browser's input uses. Pass one or the other. A point outside the viewport fails, since coordinates never scroll. With a point, the result has `target`, the element found there: its tag, id, and class, its role and accessible name when it has a role, and a `ref` to act on it again. Coordinates suit canvases, maps, and charts, or a point read off a screenshot.

`click` takes `button` (`left`, `middle`, or `right`) and `clickCount` (2 for a double click, 3 for a triple click), sent as the browser reports them, so `dblclick` and `contextmenu` listeners run.

`drag` presses on `selector` (or at `x`, `y`), moves in `steps` (default 10) toward `toSelector` (or `toX`, `toY`), and releases there. The source is scrolled into view; the drop point is read without scrolling, so both must be visible at once. Pages that follow mouse or pointer events, such as sliders, sortable lists, and canvases, see a real press, moves, and release. For HTML5 drag and drop (`draggable` elements and `dataTransfer`), Chromium hands the drag over when the page starts one, and the server finishes it with the browser's own drag events; the result says `html5: true`. Firefox does not finish an HTML5 drag started this way, so there a drag from an HTML5-draggable element is dispatched from the page as drag events sharing one `DataTransfer`; links and images carry their URL as a real drag would, and the result says `synthetic: true` and `dropped`, whether the target took the drop by canceling `dragover` and `drop`; when it did not, the source's `dragend` sees `dropEffect` `none`. Those events are untrusted, which a few pages reject. A drag that fails partway releases the mouse button, so the next action does not start with it held.

`scroll` with `x` and `y`, or with a `selector` and deltas, sends a real mouse wheel at that point, which scrolls whatever is under the pointer, such as a list or map inside the page; a `selector` alone still scrolls its element into view, and deltas alone scroll the page. Firefox scrolls smoothly, so the new position settles over a few hundred milliseconds.

## File Upload

`upload_file` sets files on a file input and fires `input` and `change`, as a user picking files would. `selector` can be the `<input type="file">` itself (hidden ones work, which is how most upload buttons are built), a `<label>` for it, or an element with one inside, such as a styled drop area. On Chromium it can also be a button that opens a file chooser from script: the server clicks it, takes the chooser, and sets the files there (`chooser: true`). The browser does not say which click opened a chooser, so a chooser that something else opens in the same moment would get the files; uploads through choosers run one at a time per tab. Firefox cannot take such a chooser, so there pass the hidden input. `paths` are absolute paths; more than one needs an input with `multiple`, and `[]` clears the input. Files can come only from the server's working directory, the system temp directory, and the directories in `MCP_BROWSER_UPLOAD_DIRS` (see [Configuration](configuration.md)), so a page cannot talk the agent into uploading other files. In snapshots a file input shows as `file` with the names of its files, for example `e5 file "Attachments" value="notes.txt"`.

## Screenshot Output

`take_screenshot` returns base64 image data plus metadata such as `mimeType`, `byteLength`, and `scope`. Pass `selector` to capture a single element instead of the full page. `width` and `height` are the image's pixel size, `cssRect` the area it shows in viewport CSS pixels, and `scale` the image pixels per CSS pixel, so a point at image pixel (`ix`, `iy`) is `x = cssRect.x + ix / scale`, `y = cssRect.y + iy / scale` for `click`. If your client shows a resized image, use proportions instead: `x = cssRect.x + cssRect.width * ix / shownWidth`.

`output` changes how the image comes back. `image` returns an MCP image content block, with only the metadata in the JSON. `file` writes the decoded image to a file and returns its `path` instead of base64 data; passing `path` implies `file`. `path` must be absolute and end in `.png`, `.jpg`, `.jpeg`, or `.webp` (not `.webp` on Firefox), which also sets the format; missing parent directories are created. An existing file is only replaced with `overwrite: true`, and a symlink at `path` is replaced rather than written through. Without `path`, the image goes to a new private directory under the system temp directory. Files are created readable only by the current user. Without `output` or `path`, `take_screenshot` returns base64 data as before.

## What an Action Changed

`click`, `hover`, `drag`, `type`, `select`, `press_key`, and `upload_file` return a `changes` field that says what the action did to the page, so checking the result usually needs no screenshot, `get_snapshot`, or `wait_for`. Before the action, the page records its visible headings and controls as `get_snapshot` would. Afterwards the server waits for the page to settle: until the DOM has had no mutations for 150 ms, and the document, fetch, and XHR requests and the timers of 50 ms to 1 s the action started have finished, for at most 2 s. Timers cover a redirect a moment after a sign-in message or a search debounced until typing pauses; timers of a polling or animation loop, set from inside a timer's callback or with a handler that already ran, are not waited for. While an action is tracked, the page's `setTimeout` is wrapped to count them, and restored afterwards. When the action starts a navigation, it waits, for at most 10 s in all, until the new document has parsed, its DOM has been quiet for 150 ms, and its own fetch and XHR requests have finished. For example, ticking a checkbox, picking a language, and saving, in one `run_steps` call, returns:

```json
"changes": {
  "updated": ["e7 checkbox \"Weekly digest\" checked", "e8 combobox \"Language\" value=\"fr\""],
  "text": ["Settings revision: 1", "Settings saved (revision 1)"]
}
```

`changes` has whichever of these apply:

- `added`, `removed`, and `updated`: snapshot lines, with refs, for headings and controls that appeared, disappeared, or changed name, value, `checked`, `filled`, or `disabled` (at most 15 each, with `addedMore` and so on counting the rest). Lines in `removed` name elements that are gone, so their refs no longer resolve.
- `text`: the visible text of elements the action added or whose text it changed, such as an error message or a toast, of elements it revealed by removing `hidden` or `aria-hidden` or opening a `<dialog>`, and of live regions (`role=alert` or `status`, `aria-live`, `<output>`) whose shown text changed, at most 5 entries of 160 characters. Text inside controls, or made only of the text of controls inside it (a list item around a link), is left out, since the controls' lines cover it, and so are 1-pixel screen-reader-only regions.
- `url` and `title`, when they changed.
- `navigated: true` with `url`, `title`, and `nodes`, the new document's snapshot lines (at most 40, with `nodesMore`), when the action loaded a new document. Its refs work at once.
- `consoleErrors` and `dialogs`: console errors and uncaught exceptions since the action started, and alert, confirm, or prompt dialogs it opened (at most 5 each). A missing favicon is not reported.
- `stillLoading`: the URLs of requests still running when the wait ran out.

When nothing in that list changed, `changes` is `{ "none": true }`. Changes that come later than that, such as behind a longer timer, a `setInterval`, or a server push, are not covered; follow with `wait_for` for those. Images, scripts, styles, long-lived connections (WebSocket, EventSource), beacons, and requests from extensions are not waited for; on a Firefox release that does not report request types, every http(s) request is. Text revealed only by a class or style change is listed for the first 200 live regions on the page and not otherwise. Pages with more than 500 visible headings and controls are compared on the first 500. `{ "unavailable": true }` means the page could not report, for example because it navigated in a way the server could not follow. An action whose element is not found, or that fails, returns no `changes`.

## Batched Steps

`run_steps` runs several session tools in order in one call, so an action and the check of its result take one round trip instead of several:

```json
{
  "sessionId": "chromium:session-1",
  "steps": [
    {
      "tool": "click",
      "arguments": { "selector": "text=Email notifications" }
    },
    {
      "tool": "select",
      "arguments": { "selector": "name=Language", "value": "fr" }
    },
    { "tool": "click", "arguments": { "selector": "text=Save changes" } }
  ]
}
```

Any tool that takes `sessionId` can be a step, with its arguments minus `sessionId`, plus `sleep` (`ms`, at most 30000). Up to 50 steps are validated before any of them runs. A step fails when its tool throws or reports `found: false` for a missing element (`inspect_element` excepted, since it may be checking that an element is gone). The call stops at the first failing step unless `continueOnError` is true, and reports each step's result or error. When the batch contains `click`, `hover`, `drag`, `type`, `select`, `press_key`, or `upload_file` (also inside `if` and `repeat`), the result has one `changes` field, as described in [What an Action Changed](#what-an-action-changed), covering the whole batch from before its first step to after its last, and the steps themselves report none. When any step fails, the result also has a `page` field with the current URL, title, and up to 40 visible controls (a `ref`, role, name, value or checked state, and a `locator` to use in the next call), so the batch can be fixed without another look at the page. Password fields are listed without their value. Screenshots come back as image content blocks instead of base64 text; the step result keeps the metadata and an `image` field with the 1-based position of its image.

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

## Several Tabs At Once

`run_tabs` runs step lists in several tabs at the same time and returns every tab's results in one reply. Reading five pages then takes about as long as the slowest one, in one call:

```json
{
  "browserFamily": "chromium",
  "tabs": [
    {
      "url": "https://example.com/a",
      "steps": [{ "tool": "read_text", "arguments": { "maxChars": 4000 } }]
    },
    {
      "url": "https://example.com/b",
      "steps": [{ "tool": "read_text", "arguments": { "maxChars": 4000 } }]
    },
    {
      "sessionId": "chromium:1f0c…",
      "steps": [
        { "tool": "take_screenshot", "arguments": { "output": "image" } }
      ]
    }
  ]
}
```

- A tab with `url` opens a new tab, attaches to it, loads the URL (`waitUntil`, default `complete`), and runs its steps. A tab with `sessionId` runs its steps in that attached tab; each session can appear once.
- Steps are the same as in `run_steps`, including `if` and `repeat`, at most 50 per tab. Every tab's steps are validated before any tab opens.
- All tabs run at once by default, at most 8 in a call; `concurrency` lowers that, for example for a site that limits how fast it is read. Each tab has `timeoutMs` (default 60000) from opening to its last step. A tab that times out starts no more steps (a running `sleep` ends at once), a tab opened for it is closed, and the call waits for the step in progress to end; its result reports the steps that ran. A tab that fails or times out does not stop the others, and a failed tab reports the page's controls as in `run_steps`.
- Tabs opened for a `url` are closed afterwards, and each result's `closed` says whether that worked (with `closeError` if not). With `keepTabs`, they stay open and attached, and each result reports its `sessionId`.
- In `auto` browser mode, give `browserFamily` for the tabs opened by URL, as with `new_tab`.
- The results list the tabs in the order given, each with `ok`, its step results, and `durationMs`; screenshots from any tab come back as numbered image content.

Tabs in the background of a visible browser can run timers late and pause rendering. Loading, reading text, and waiting work there; for screenshots or lazy-loaded content, keep the tab in view or use a headless browser.

## Reading Page Text

`read_text` returns the visible text of the page's main content as plain lines, with runs of spaces and blank lines collapsed. It reads the first visible `main` or `[role=main]`, else the only visible `article`, else the body; `source` says which. With `selector`, it reads that element instead, and returns no text if the element is hidden (`visible: false`). `maxChars` caps the text (default 8000, at most 100000), and `totalChars` and `truncated` tell whether there was more. With `links: true`, it also lists the http(s) links inside, with their text and absolute URL, deduplicated, up to `maxLinks` (default 50, at most 200); use it to collect search results before opening them with `run_tabs`.

## Network Control

`set_network` changes what the tab's requests do, for testing how a page behaves when an API fails, is slow, or returns something specific:

```json
{
  "sessionId": "chromium:session-1",
  "rules": [
    { "url": "*://*/ads/*", "action": "block" },
    {
      "url": "*/api/cart*",
      "action": "mock",
      "status": 500,
      "contentType": "application/json",
      "body": "{\"error\":\"down\"}"
    }
  ],
  "headers": { "X-Feature-Flag": "new-checkout" },
  "latencyMs": 400
}
```

- `rules` match the full URL with a glob, `*` for any run of characters and `?` for one, as CDP's Fetch patterns do; the first match wins. `block` fails the request as blocked by the client; `mock` answers it without the network, with `status` (default 200), `contentType`, `body`, and `headers`, and allows CORS unless the rule sets `Access-Control-Allow-Origin`. The result lists each rule with `hits`, how many requests it has matched.
- `headers` adds request headers to every request of the tab.
- `offline` takes the tab offline. `latencyMs`, `downloadKbps`, and `uploadKbps` throttle it, on Chromium only: WebDriver BiDi has no throttling.
- A call replaces the fields it gives and keeps the others; `rules: []` and `headers: {}` clear those, and `reset: true` clears everything. The settings last until the session detaches.

On Chromium only requests that match a rule are paused, so others are not slowed. On Firefox, whose BiDi URL patterns cannot express globs, every request of the tab is intercepted while rules or headers are set and matched by the server, which adds a local round trip to each.

## Performance

Both tools are in the `performance` group, which `MCP_BROWSER_TOOLS=performance` adds.

`get_performance` reports on the current page:

- `navigation`: the navigation type, protocol, redirects, `domContentLoadedMs`, `loadMs`, and transfer size.
- `vitals`, each with a `value` and a `rating` of `good`, `needs-improvement`, or `poor` by the Web Vitals thresholds: `ttfb`, `fcp`, `lcp` (with its element or image URL), `cls` (the worst session window of layout shifts not caused by input), and `inp`, estimated as the Web Vitals library does (the interaction at the 98th percentile, dropping one outlier per 50 interactions), with `slowestMs` and the number of `interactions`. Browsers keep only interactions of 104 ms or more from before the call, so `inp` covers those. TTFB, FCP, and LCP of a prerendered page count from when it was shown. After a restore from the back/forward cache, `restoredFromCache` is true, the load metrics are `null`, and the others cover only the time since the restore. Values the browser does not expose are `null`; Firefox has no layout shifts or long tasks.
- `longTasks`: count, total, and longest.
- `resources`: count and transfer size, by initiator type, and the five slowest.
- `metrics` (Chromium): JS heap, DOM nodes, event listeners, layouts and style recalculations with their time, and script and task time, counted since the session attached.

`record_trace` records a Chromium trace with the categories DevTools' Performance panel uses: `action: "start"` (with `screenshots: true` for a filmstrip), then act, then `action: "stop"`, which writes the trace as JSON to `path` (absolute, ending in `.json`) or a new private temp file, and returns `path`, `bytes`, and `durationMs`. Open the file in the Performance panel. Files are written readable only by the current user, and an existing file is replaced only with `overwrite: true`; the path is checked before the trace stops, and a trace that still cannot be written there goes to a temp file, with `error` saying why. Firefox has no tracing over WebDriver BiDi.

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
