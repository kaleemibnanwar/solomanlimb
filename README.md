# octolimb

**MCP for any browser.** OctoLimb lets any MCP-capable agent — Claude Code, Claude Desktop, OpenAI Codex, or anything else that speaks MCP — drive a real Chrome browser. Click, type, scroll, read the page, run JS, and replay saved step-by-step "recipes", all through your everyday logged-in browser.

```
any MCP agent ──stdio or HTTP──▶ octolimb host (the bridge) ──WebSocket──▶ Chrome extension (drives the browser)
```

It's two pieces that ship together:

| Piece | What it does | Where |
|---|---|---|
| **`octolimb` host** | The MCP server. Speaks MCP to your agent and relays tool calls to the browser. A small Node process. | `src/` (builds to `dist/`) |
| **Chrome extension** | The browser actuator. Receives tool calls and performs them in Chrome (CDP input events + a DOM indexer). Plain JS, no build step. | `extension/` |

> **Why two processes?** A Chrome extension cannot listen on a socket or serve stdio — that's a browser security boundary. So the MCP server must be a separate host process; the extension is the browser-side half that connects out to it.

---

## Install

### 1. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` folder.

The extension dials out to `ws://127.0.0.1:32528` and reconnects automatically whenever the host comes up.

### 2. Install the host

```bash
npm install -g octolimb      # from npm, or:
# git clone https://github.com/kaleemibnanwar/octolimb.git && cd octolimb && npm install && npm run build && npm link
```

Confirm it's on your path:

```bash
octolimb --help
```

---

## Usage

The host runs as either a **stdio** server (the default, and the most universal) or a **Streamable HTTP** server. Both always also start the WebSocket relay on `:32528` for the extension.

### Octopus Studio

Octopus Studio already ships its own in-process OctoLimb bridge — you do **not** need the standalone host. Just load the extension and enable **Settings → "Enable OctoLimb MCP Bridge"**.

> **Don't run the standalone host at the same time** — Studio's bridge and this host both bind `:32527`/`:32528`. Pick one. (If you must run both, start the host with `--http-port 32529 --ws-port 32530`.)

### Claude Code

```bash
claude mcp add octolimb -- octolimb
```

Or via `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "octolimb": {
      "command": "octolimb",
      "args": []
    }
  }
}
```

### Claude Desktop

Open **Settings → Developer → Edit Config** and add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "octolimb": {
      "command": "octolimb",
      "args": []
    }
  }
}
```

Then restart Claude Desktop. (HTTP is also possible — see "Any other client" below.)

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.octolimb]
command = "octolimb"
args = []
```

### Any other MCP client

- **stdio** (most common): configure it to spawn `octolimb` as a command.
- **Streamable HTTP**: start the host with `octolimb --http`, then point the client at `http://127.0.0.1:32527/mcp`.

```bash
octolimb --http            # HTTP MCP on :32527 + WS relay on :32528
octolimb --http-port 32529 --ws-port 32530   # override ports
```

---

## Tools

The host exposes **24 tools**:

| Category | Tools |
|---|---|
| Navigation | `go_to_url`, `go_back`, `open_tab`, `close_tab`, `switch_tab`, `search_google` |
| Page reading | `read_page` (URL/title + indexed elements), `execute_js`, `get_dropdown_options` |
| Interaction | `click_element`, `input_text`, `select_dropdown_option`, `send_keys`, `wait` |
| Scrolling | `scroll_to_percent`, `scroll_to_top`, `scroll_to_bottom`, `previous_page`, `next_page`, `scroll_to_text` |
| Recipes | `find_recipe`, `run_recipe`, `done` (auto-saves a task on success), `cache_content` |

See `extension/README.md` for how the extension implements these (nanobrowser's DOM indexer + CDP input dispatch).

## Saved recipes

`done`, `find_recipe`, and `run_recipe` implement a lightweight "recipe" cache: a successfully completed task is saved and can be replayed later on the same domain in a single `run_recipe` call instead of step-by-step. Recipes are stored as JSON at `~/.octolimb/recipes.json` (override the directory with the `OCTOLIMB_HOME` env var).

## Security notes

- The host binds to **`127.0.0.1` only** — it never listens on a network interface.
- The WebSocket relay only accepts connections whose `Origin` is `chrome-extension://` (i.e. your extension), so other local processes can't impersonate the browser.
- Driving the browser via Chrome's debugger shows Chrome's unavoidable **"OctoLimb Bridge is debugging this browser"** banner on the tabs it attaches to.
- `execute_js` runs arbitrary JavaScript in the page — grant the extension only to tasks you actually want automated.

## License

Apache-2.0 — see [LICENSE](LICENSE). The DOM-indexing script (`extension/buildDomTree.js`) is copied from nanobrowser and carries its own Apache-2.0 license files in `extension/`.
