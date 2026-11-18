# OctoLimb Bridge (Chrome extension)

> This folder is the browser half of the standalone **octolimb** project — see the [top-level README](../README.md) for install and client setup (Claude, Codex, Soloman Studio, …).

Connects this Chrome browser to the octolimb host (the standalone MCP bridge in `src/`, or Soloman Studio's in-process bridge in `src/main/octolimb_bridge.ts`), letting any MCP-capable agent drive this
browser. It implements the full nanobrowser (`browserbridge-extension`)
action set — navigation, tabs, indexed element click/input, scrolling,
dropdowns, key presses — plus two extras this architecture needs since
Studio (not the extension) drives every step: `read_page` (get an indexed
snapshot of the page) and `execute_js` (run arbitrary JS in the page).
See the tool list in `src/main/octolimb_bridge.ts`'s `OCTOLIMB_TOOLS`.

This extension is intentionally **not** built or bundled by Soloman Studio
Studio — it's a separate, independently loaded Chrome extension with no
build step (plain JS, loaded as MV3 ES modules).

## Install

1. Open `chrome://extensions`.
2. Enable "Developer mode" (top-right toggle).
3. Click "Load unpacked" and select this `octolimb/chrome-extension`
   folder.
4. In Soloman Studio, make sure Settings → "Enable OctoLimb MCP Bridge" is
   on. Its status line will show "Extension connected" once this
   extension's service worker connects.

## How it interacts with the page

Ported from nanobrowser's own methodology (studied from `browserbridge-extension`, Apache 2.0):

- `read_page` injects `buildDomTree.js` — nanobrowser's own DOM-indexing
  script, copied verbatim — to find every visible/interactive element
  (including same-origin iframes and shadow DOM) and assign each one an
  index. `click_element`, `input_text`, and the dropdown tools act on an
  element by that index.
- `click_element`, `input_text`, and `send_keys` try real input-event
  dispatch first, via `chrome.debugger` (Chrome DevTools Protocol —
  `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent`/`Input.insertText` in
  `cdp.js`), the same mechanism nanobrowser gets from Puppeteer-core
  underneath. This is closer to a real user action than a synthetic
  `element.click()`, so it works on more sites. If a debugger can't attach
  (e.g. DevTools is already open on that tab), it falls back to a plain DOM
  script — nanobrowser's own fallback tier.
- **The "debugger" permission shows Chrome's own banner** ("OctoLimb Bridge
  is debugging this browser") on tabs it attaches to — this is unavoidable
  and is the same tradeoff nanobrowser makes for the same capability.

## How it reconnects

The background service worker (`background.js`) keeps a WebSocket
connection to `ws://127.0.0.1:32528` (Soloman Studio's in-process bridge)
and reconnects automatically with backoff whenever it drops — after a
Chrome restart (`chrome.runtime.onStartup`), after Studio is closed and
reopened, or after any transient disconnect. A periodic `chrome.alarms`
alarm acts as a backstop in case the MV3 service worker gets suspended
mid-retry. No manual reconnect step is needed on either side.
