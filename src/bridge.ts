import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "./logger.js";
import {
  getRecipeByFingerprint,
  listRecipesForDomain,
  recordRecipeOutcome,
  upsertRecipe,
  type RecipeStep,
} from "./recipes.js";

const logger = createLogger("octolimb-bridge");

const DEFAULT_HTTP_PORT = 32527;
const DEFAULT_WS_PORT = 32528;
const TOOL_CALL_TIMEOUT_MS = 30_000;

let httpPort = DEFAULT_HTTP_PORT;
let wsPort = DEFAULT_WS_PORT;

export type OctoLimbBridgeStatus = {
  running: boolean;
  extensionConnected: boolean;
  lastError: string | null;
};

let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
let extensionSocket: WebSocket | null = null;

// The Streamable HTTP transport is stateful per session: each independent
// MCP client opens its own session with its own `initialize` handshake. A
// single shared transport instance can only ever be initialized once, so
// every session gets its own transport + server pair, looked up by the
// `Mcp-Session-Id` header on subsequent requests.
const sessions = new Map<string, StreamableHTTPServerTransport>();

let status: OctoLimbBridgeStatus = {
  running: false,
  extensionConnected: false,
  lastError: null,
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const pendingCalls = new Map<string, PendingCall>();

function setStatus(patch: Partial<OctoLimbBridgeStatus>): void {
  status = { ...status, ...patch };
}

export function getOctoLimbBridgeStatus(): OctoLimbBridgeStatus {
  return status;
}

function rejectAllPending(reason: string): void {
  for (const pending of pendingCalls.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(reason));
  }
  pendingCalls.clear();
}

const EXTENSION_RECONNECT_GRACE_MS = 5_000;
const EXTENSION_RECONNECT_POLL_MS = 300;

function isExtensionConnected(): boolean {
  return !!extensionSocket && extensionSocket.readyState === WebSocket.OPEN;
}

// The extension's own reconnect loop (backoff + chrome.alarms backstop, see
// extension/background.js) can take a few seconds to re-establish after a
// host restart or a transient drop. Give it a short grace window before
// reporting "not connected" so a tool call that lands mid-reconnect doesn't
// fail a call that would have succeeded moments later.
async function waitForExtensionConnection(timeoutMs: number): Promise<boolean> {
  if (isExtensionConnected()) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, EXTENSION_RECONNECT_POLL_MS));
    if (isExtensionConnected()) return true;
  }
  return false;
}

async function callExtensionTool(tool: string, args: unknown): Promise<unknown> {
  if (!(await waitForExtensionConnection(EXTENSION_RECONNECT_GRACE_MS))) {
    throw new Error(
      "The OctoLimb browser extension is not connected. Make sure Chrome is open with the OctoLimb extension loaded and active, then try again — it reconnects automatically within a few seconds once available.",
    );
  }
  const socket = extensionSocket!;
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error("OctoLimb tool call timed out waiting for the browser extension."));
    }, TOOL_CALL_TIMEOUT_MS);
    pendingCalls.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ type: "tool_call", id, tool, args }));
  });
}

function handleExtensionMessage(data: RawData): void {
  let message: { type?: string; id?: string; result?: unknown; error?: string };
  try {
    message = JSON.parse(data.toString());
  } catch {
    logger.warn("Received malformed message from OctoLimb extension");
    return;
  }
  if (!message.id) return;
  const pending = pendingCalls.get(message.id);
  if (!pending) return;
  pendingCalls.delete(message.id);
  clearTimeout(pending.timeout);
  if (message.type === "tool_result") {
    pending.resolve(message.result);
  } else {
    pending.reject(new Error(message.error ?? "Unknown OctoLimb tool error"));
  }
}

// An `intent` field on nanobrowser's own action schemas (its "purpose of
// this action" — every ported action below has one). It's optional there
// (`.default('')`) and, per nanobrowser's builder.ts, purely used for a
// progress/transparency message — never consulted for the actual DOM
// interaction — so it's safe to accept-and-ignore if the model omits it.
const INTENT_PROPERTY = {
  intent: { type: "string" as const, description: "Purpose of this action" },
};

// The full nanobrowser (browserbridge-extension) action set, ported onto
// this bridge's tool_call/tool_result protocol, matching nanobrowser's own
// zod schemas field-for-field. `read_page` and `execute_js` are additions
// beyond nanobrowser's own action list: this architecture has no local
// agent loop in the extension that automatically re-reads the DOM each step
// (the MCP client's model drives every step), so the model needs an explicit
// way to inspect the page and get element indices before calling index-based
// actions like `click_element` or `input_text`.
const OCTOLIMB_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "done",
    description:
      "Complete task. Always call this once you're finished with a browser task, whether it succeeded or not — besides signaling completion, on success this automatically saves everything you did since the last find_recipe/done as a recipe (using `text` as its instruction), so a future task on this site can replay it via find_recipe instead of redoing every step. This is the only thing that triggers auto-saving — individual actions (go_to_url, click_element, etc.) are silently recorded as you go, but nothing is persisted until done() is called with success: true.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        success: { type: "boolean" },
      },
      required: ["text", "success"],
    },
  },
  {
    name: "search_google",
    description:
      "Search the query in Google. Opens a new tab for this task if none is active yet, otherwise reuses the tab already in use for this task — never the user's own currently-focused tab. The query should be a search query like humans search in Google, concrete and not vague or super long. More the single most important items.",
    inputSchema: {
      type: "object",
      properties: { ...INTENT_PROPERTY, query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "go_to_url",
    description:
      "Navigate to URL. Opens a new tab for this task if none is active yet, otherwise navigates the tab already in use for this task — never the user's own currently-focused tab, and every later action (click_element, read_page, etc.) keeps targeting that same tab even if the user clicks into a different one meanwhile.",
    inputSchema: {
      type: "object",
      properties: { ...INTENT_PROPERTY, url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "go_back",
    description: "Go back to the previous page",
    inputSchema: { type: "object", properties: { ...INTENT_PROPERTY } },
  },
  {
    name: "wait",
    description:
      "Wait for x seconds default 3, do NOT use this action unless user asks to wait explicitly",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        seconds: { type: "integer", description: "amount of seconds (default 3)" },
      },
    },
  },
  {
    name: "read_page",
    description:
      "Read the current page in this task's tab: URL, title, and an indexed list of interactive elements. Call this before click_element, input_text, or the dropdown tools to get valid indices. Body text is omitted by default — pass include_text when you actually need to read page content, not just interact with it.",
    inputSchema: {
      type: "object",
      properties: {
        include_text: {
          type: "boolean",
          description:
            "Include the page's visible body text (default false — most steps only need element indices)",
        },
        max_text_length: {
          type: "integer",
          description:
            "Max characters of body text to return when include_text is true (default 4000)",
        },
        viewport_expansion: {
          type: "integer",
          description:
            "Expand the viewport by this many pixels when indexing elements (default 0 — only visible elements are indexed). Set to -1 to index all interactive elements on the page regardless of visibility.",
        },
      },
    },
  },
  {
    name: "click_element",
    description: "Click element by index",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        index: { type: "integer", description: "index of the element" },
        xpath: {
          type: "string",
          description: "xpath of the element (optional fallback if the index is stale)",
        },
      },
      required: ["index"],
    },
  },
  {
    name: "input_text",
    description: "Input text into an interactive input element",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        index: { type: "integer", description: "index of the element" },
        text: { type: "string", description: "text to input" },
        xpath: {
          type: "string",
          description: "xpath of the element (optional fallback if the index is stale)",
        },
      },
      required: ["index", "text"],
    },
  },
  {
    name: "switch_tab",
    description:
      "Switch to tab by tab id, and make it the tab this task uses from now on (e.g. after a link opened a new tab).",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        tab_id: { type: "integer", description: "id of the tab to switch to" },
      },
      required: ["tab_id"],
    },
  },
  {
    name: "open_tab",
    description: "Open URL in a new tab, and use it as this task's tab from now on.",
    inputSchema: {
      type: "object",
      properties: { ...INTENT_PROPERTY, url: { type: "string", description: "url to open" } },
      required: ["url"],
    },
  },
  {
    name: "close_tab",
    description: "Close tab by tab id",
    inputSchema: {
      type: "object",
      properties: { ...INTENT_PROPERTY, tab_id: { type: "integer", description: "id of the tab" } },
      required: ["tab_id"],
    },
  },
  {
    name: "cache_content",
    description: "Cache what you have found so far from the current page for future use",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        content: { type: "string", description: "content to cache (default '')" },
      },
    },
  },
  {
    name: "scroll_to_percent",
    description:
      "Scrolls to a particular vertical percentage of the document or an element. If no index of element is specified, scroll the whole document.",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        yPercent: {
          type: "integer",
          description: "percentage to scroll to - min 0, max 100; 0 is top, 100 is bottom",
        },
        index: { type: "integer", description: "index of the element" },
      },
      required: ["yPercent"],
    },
  },
  {
    name: "scroll_to_top",
    description: "Scroll the document in the window or an element to the top",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        index: { type: "integer", description: "index of the element" },
      },
    },
  },
  {
    name: "scroll_to_bottom",
    description: "Scroll the document in the window or an element to the bottom",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        index: { type: "integer", description: "index of the element" },
      },
    },
  },
  {
    name: "previous_page",
    description:
      "Scroll the document in the window or an element to the previous page. If no index is specified, scroll the whole document.",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        index: { type: "integer", description: "index of the element" },
      },
    },
  },
  {
    name: "next_page",
    description:
      "Scroll the document in the window or an element to the next page. If no index is specified, scroll the whole document.",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        index: { type: "integer", description: "index of the element" },
      },
    },
  },
  {
    name: "scroll_to_text",
    description:
      "If you dont find something which you want to interact with in current viewport, try to scroll to it",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        text: { type: "string", description: "text to scroll to" },
        nth: {
          type: "integer",
          minimum: 1,
          description: "which occurrence of the text to scroll to (1-indexed, default: 1)",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "send_keys",
    description:
      "Send strings of special keys like Backspace, Insert, PageDown, Delete, Enter. Shortcuts such as `Control+o`, `Control+Shift+T` are supported as well. This gets used in keyboard press. Be aware of different operating systems and their shortcuts",
    inputSchema: {
      type: "object",
      properties: { ...INTENT_PROPERTY, keys: { type: "string", description: "keys to send" } },
      required: ["keys"],
    },
  },
  {
    name: "get_dropdown_options",
    description: "Get all options from a native dropdown",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        index: { type: "integer", description: "index of the dropdown element" },
      },
      required: ["index"],
    },
  },
  {
    name: "select_dropdown_option",
    description:
      "Select dropdown option for interactive element index by the text of the option you want to select",
    inputSchema: {
      type: "object",
      properties: {
        ...INTENT_PROPERTY,
        index: { type: "integer", description: "index of the dropdown element" },
        text: { type: "string", description: "text of the option" },
      },
      required: ["index", "text"],
    },
  },
  {
    name: "execute_js",
    description:
      "Execute arbitrary JavaScript in this task's tab (page context) and return the result.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript to execute. Returns the value of the last expression, like a REPL (e.g. `document.title` returns the title with no explicit return needed).",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "find_recipe",
    description:
      "List every previously saved step-by-step trajectory for this domain, before doing the task manually. Returns each saved recipe's own instruction text plus its fingerprint and success/failure counts — no steps yet. Read the instructions like retrieved documents and judge for yourself whether any of them is the same task you're about to do, even if worded differently ('post a tweet' vs 'tweet something'); ignore recipes that don't actually match. If one fits, pass its fingerprint straight into run_recipe to replay the whole task in one call instead of one tool call per step. Always try this first for any task that sounds like something you (or a prior session) may have already done on this site.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The site's domain the task runs on (e.g. 'x.com')",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "run_recipe",
    description:
      "Execute a sequence of OctoLimb tool steps in one call, without round-tripping to you between each one — use this to batch obvious action chains (e.g. go_to_url, then click_element, then input_text) or to replay steps returned by find_recipe. Runs steps exactly as given, in order, via the real browser — nothing is added or skipped, so include every step you'd need if doing this by hand one call at a time (e.g. a read_page before an index-based step on a page you haven't indexed yet in this session). Stops at the first step that errors, returning every result so far plus which step failed — pick up manually from there. Pass `fingerprint` (from find_recipe) to replay and auto-update its success/failure count instead of passing `steps` directly. Pass `save_as` alongside `steps` to save this task once it fully succeeds — this saves every tool call made in the session so far (including ones made outside this run_recipe call, e.g. an earlier read_page), not just the `steps` in this call, so replay later needs nothing extra.",
    inputSchema: {
      type: "object",
      properties: {
        fingerprint: {
          type: "string",
          description:
            "Replay a saved recipe by the fingerprint returned from find_recipe (mutually exclusive with steps)",
        },
        steps: {
          type: "array",
          description:
            "Ad-hoc steps to run now, each a real OctoLimb tool call (mutually exclusive with fingerprint)",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "Name of an OctoLimb tool, e.g. click_element" },
              args: { type: "object", description: "Arguments for that tool call" },
            },
            required: ["tool"],
          },
        },
        save_as: {
          type: "object",
          description:
            "If provided with `steps` and every step succeeds, save this as a recipe for future find_recipe lookups",
          properties: {
            instruction: { type: "string" },
            domain: { type: "string" },
          },
          required: ["instruction", "domain"],
        },
      },
    },
  },
];

// A real, separate Chrome browser window that the user opts into by
// installing the OctoLimb extension. It should only be reached for when the
// user explicitly asks for browser automation on a real website (e.g. "post
// this on reddit", "go to twitter.com and...") — never proactively for
// tasks the user didn't ask to run in a live browser.
const OCTOLIMB_USAGE_SCOPE =
  "[Real Chrome browser via the OctoLimb extension — drive the user's browser; use only when the task requires acting on a real website.] ";

const OCTOLIMB_TOOLS: Tool[] = OCTOLIMB_TOOL_DEFINITIONS.map((tool) => ({
  ...tool,
  description: OCTOLIMB_USAGE_SCOPE + tool.description,
}));

const OCTOLIMB_TOOL_NAMES = new Set(OCTOLIMB_TOOLS.map((tool) => tool.name));

type RecipeStepResult = { tool: string; args: Record<string, unknown>; result: unknown };

type StepRecorder = (tool: string, args: Record<string, unknown>, result: unknown) => void;

// Runs steps via the same callExtensionTool used for a single live tool
// call — each step gets its own fresh TOOL_CALL_TIMEOUT_MS window, so a
// long recipe doesn't need a bigger overall timeout budget than a single
// step would. Stops at the first failure so the caller (the model) can
// pick up manually from exactly where the cached/batched trajectory
// diverged from the live page, rather than the whole call hard-failing.
//
// Runs `steps` exactly as given — nothing injected or skipped, so a
// replay behaves identically to the caller making these same calls one at
// a time. `onStep` (when given) is called after each step actually
// succeeds, so the session-level recording buffer in
// createOctoLimbMcpServer captures every tool call this makes, the same
// way it captures direct individual calls — see that function for why:
// a recipe is only replayable if whatever got saved is complete (e.g.
// includes the read_page that established the indices it clicks/types
// into), and the fix for an incomplete recipe is making sure recording
// never drops steps, not guessing at replay time what might be missing.
async function runRecipeSteps(
  steps: RecipeStep[],
  onStep?: StepRecorder,
): Promise<{
  completed: boolean;
  results: RecipeStepResult[];
  failedAtStep?: number;
  error?: string;
}> {
  const results: RecipeStepResult[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (
      !OCTOLIMB_TOOL_NAMES.has(step.tool) ||
      step.tool === "run_recipe" ||
      step.tool === "find_recipe"
    ) {
      return {
        completed: false,
        results,
        failedAtStep: i,
        error: `Invalid step tool: ${step.tool}`,
      };
    }
    try {
      const stepArgs = step.args ?? {};
      const result = await callExtensionTool(step.tool, stepArgs);
      results.push({ tool: step.tool, args: stepArgs, result });
      onStep?.(step.tool, stepArgs, result);
    } catch (error) {
      return {
        completed: false,
        results,
        failedAtStep: i,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { completed: true, results };
}

async function handleFindRecipe(args: { domain?: string }): Promise<unknown> {
  if (!args.domain) {
    return { found: false, error: "domain is required" };
  }
  const recipes = listRecipesForDomain(args.domain);
  if (recipes.length === 0) return { found: false, recipes: [] };
  return {
    found: true,
    recipes,
  };
}

async function handleRunRecipe(
  args: {
    fingerprint?: string;
    steps?: RecipeStep[];
    save_as?: { instruction: string; domain: string };
  },
  onStep?: StepRecorder,
): Promise<unknown> {
  let steps: RecipeStep[];
  let replayFingerprint: string | undefined;

  if (args.fingerprint) {
    const recipe = getRecipeByFingerprint(args.fingerprint);
    if (!recipe) {
      return { completed: false, error: `No recipe found for fingerprint ${args.fingerprint}` };
    }
    steps = recipe.steps;
    replayFingerprint = args.fingerprint;
  } else if (args.steps && args.steps.length > 0) {
    steps = args.steps;
  } else {
    return { completed: false, error: "Provide either `fingerprint` or `steps`" };
  }

  const outcome = await runRecipeSteps(steps, onStep);

  if (replayFingerprint) {
    // Replaying a saved recipe: update its staleness signal either way.
    recordRecipeOutcome(replayFingerprint, outcome.completed);
  }
  // `save_as` persistence happens in createOctoLimbMcpServer, from the
  // session's full recording buffer rather than from `steps` here — see
  // the comment on `runRecipeSteps` for why saving only what was passed
  // into this one call isn't enough to make the saved recipe replayable.

  return outcome;
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

// Once a single "task" (the steps between two done() calls, or since
// session start) runs past this many real actions, treat it as too long to
// usefully cache and stop recording it — bounds the memory a runaway/
// exploratory session can hold, and keeps a saved recipe short enough that
// a partial UI change doesn't invalidate all of it (see run_recipe, which
// stops replay at the first failing step anyway).
const MAX_AUTO_RECORD_STEPS = 50;

export function createOctoLimbMcpServer(): McpServer {
  const server = new McpServer(
    { name: "OctoLimb", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: OCTOLIMB_TOOLS,
  }));

  // Auto-recording state for this MCP session: every real (non find_recipe/
  // run_recipe) tool call the model makes directly — not batched through
  // run_recipe, which has its own explicit save_as — is appended here as it
  // happens. done({success: true}) turns the buffer into a saved recipe
  // using its `text` as the instruction, since the model rarely opts into
  // run_recipe's batching for an exploratory task it's doing for the first
  // time, which used to mean nothing ever got cached for it.
  let stepBuffer: RecipeStep[] = [];
  let bufferOverflowed = false;
  let sessionDomain: string | null = null;

  function recordStep(name: string, args: Record<string, unknown>, result: unknown): void {
    const url =
      (typeof args.url === "string" && args.url) ||
      (typeof (result as { url?: unknown } | null)?.url === "string"
        ? (result as { url: string }).url
        : undefined);
    if (url) {
      const domain = extractDomain(url);
      if (domain) sessionDomain = domain;
    }
    if (stepBuffer.length >= MAX_AUTO_RECORD_STEPS) {
      bufferOverflowed = true;
      return;
    }
    stepBuffer.push({ tool: name, args });
  }

  function finalizeAutoRecording(success: boolean, instruction: string | undefined): void {
    if (
      success &&
      !bufferOverflowed &&
      stepBuffer.length > 0 &&
      sessionDomain &&
      instruction?.trim()
    ) {
      upsertRecipe({ instruction: instruction.trim(), domain: sessionDomain, steps: stepBuffer });
    }
    stepBuffer = [];
    bufferOverflowed = false;
  }

  async function dispatchRunRecipe(runArgs: {
    fingerprint?: string;
    steps?: RecipeStep[];
    save_as?: { instruction: string; domain: string };
  }): Promise<unknown> {
    // Every step run_recipe actually executes — ad-hoc `steps` or a
    // fingerprint replay — feeds the same session buffer as a direct
    // individual call, via recordStep. So when `save_as` asks to persist
    // this task, it's saved from that buffer (the true, complete trace of
    // everything this session has done up to and including this call, e.g.
    // a read_page made as its own call earlier), not from just the
    // `steps` array passed into this one call — that's what guarantees a
    // saved recipe is actually replayable later with nothing missing.
    const outcome = await handleRunRecipe(runArgs, recordStep);
    if (
      runArgs.save_as &&
      (outcome as { completed?: boolean }).completed &&
      !bufferOverflowed &&
      stepBuffer.length > 0
    ) {
      const fingerprint = upsertRecipe({
        instruction: runArgs.save_as.instruction,
        domain: runArgs.save_as.domain,
        steps: stepBuffer,
      });
      return { ...(outcome as object), savedFingerprint: fingerprint };
    }
    return outcome;
  }

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    if (!OCTOLIMB_TOOL_NAMES.has(name)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown OctoLimb tool: ${name}` }],
      };
    }
    try {
      const toolArgs = (args ?? {}) as Record<string, unknown>;
      const result =
        name === "find_recipe"
          ? await handleFindRecipe(toolArgs as { domain?: string })
          : name === "run_recipe"
            ? await dispatchRunRecipe(
                toolArgs as {
                  fingerprint?: string;
                  steps?: RecipeStep[];
                  save_as?: { instruction: string; domain: string };
                },
              )
            : await callExtensionTool(name, toolArgs).then((toolResult) => {
                if (name === "done") {
                  finalizeAutoRecording(!!toolArgs.success, toolArgs.text as string | undefined);
                } else {
                  recordStep(name, toolArgs, toolResult);
                }
                return toolResult;
              });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  });

  return server;
}

function attachWebSocketServer(): void {
  wss = new WebSocketServer({
    host: "127.0.0.1",
    port: wsPort,
    verifyClient: (info: { origin: string }) =>
      typeof info.origin === "string" && info.origin.startsWith("chrome-extension://"),
  });

  wss.on("connection", (socket) => {
    logger.info("OctoLimb extension connected");
    if (extensionSocket && extensionSocket !== socket) {
      extensionSocket.close(1000, "replaced by new connection");
    }
    extensionSocket = socket;
    setStatus({ extensionConnected: true, lastError: null });

    socket.on("message", handleExtensionMessage);
    socket.on("close", () => {
      if (extensionSocket === socket) {
        extensionSocket = null;
        setStatus({ extensionConnected: false });
        rejectAllPending("OctoLimb extension disconnected");
        logger.info("OctoLimb extension disconnected");
      }
    });
    socket.on("error", (error) => {
      logger.error("OctoLimb extension socket error", error);
    });
  });

  wss.on("error", (error) => {
    logger.error("OctoLimb WebSocket server error", error);
    setStatus({ lastError: String(error) });
  });
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

async function createSessionTransport(): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts: [`127.0.0.1:${httpPort}`, `localhost:${httpPort}`],
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  const server = createOctoLimbMcpServer();
  await server.connect(transport);
  return transport;
}

function handleMcpHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    void (async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsedBody: unknown;
      try {
        parsedBody = raw ? JSON.parse(raw) : undefined;
      } catch {
        jsonRpcError(res, 400, "Parse error: invalid JSON body");
        return;
      }

      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      try {
        let transport: StreamableHTTPServerTransport;
        if (sessionId && sessions.has(sessionId)) {
          transport = sessions.get(sessionId)!;
        } else if (!sessionId && req.method === "POST" && isInitializeRequest(parsedBody)) {
          transport = await createSessionTransport();
        } else {
          jsonRpcError(res, 400, "Bad Request: No valid session ID provided");
          return;
        }
        await transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        logger.error("Failed to handle OctoLimb MCP request", error);
        if (!res.headersSent) res.writeHead(500).end();
      }
    })();
  });
}

export interface StartOptions {
  httpPort?: number;
  wsPort?: number;
}

/** Start only the WebSocket relay (host ↔ extension). Used by stdio mode. */
export async function startWebSocketRelay(options: StartOptions = {}): Promise<void> {
  wsPort = options.wsPort ?? DEFAULT_WS_PORT;
  if (wss) return;
  attachWebSocketServer();
  setStatus({ running: true, lastError: null });
  logger.info(`OctoLimb bridge listening: WS ws://127.0.0.1:${wsPort}`);
}

/** Start the Streamable HTTP MCP server plus the WebSocket relay. */
export async function startHttpBridge(options: StartOptions = {}): Promise<void> {
  httpPort = options.httpPort ?? DEFAULT_HTTP_PORT;
  wsPort = options.wsPort ?? DEFAULT_WS_PORT;
  if (httpServer || wss) return;

  try {
    httpServer = http.createServer(handleMcpHttpRequest);
    httpServer.on("error", (error) => {
      logger.error("OctoLimb HTTP server error", error);
      setStatus({ lastError: String(error) });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer!.once("error", reject);
      httpServer!.once("listening", () => resolve());
      httpServer!.listen(httpPort, "127.0.0.1");
    });

    attachWebSocketServer();

    setStatus({ running: true, lastError: null });
    logger.info(
      `OctoLimb bridge listening: HTTP http://127.0.0.1:${httpPort}/mcp, WS ws://127.0.0.1:${wsPort}`,
    );
  } catch (error) {
    logger.error("Failed to start OctoLimb bridge", error);
    setStatus({ lastError: error instanceof Error ? error.message : String(error) });
    await stopBridge();
    throw error;
  }
}

export async function stopBridge(): Promise<void> {
  rejectAllPending("OctoLimb bridge stopped");

  if (extensionSocket) {
    extensionSocket.close(1000, "bridge stopped");
    extensionSocket = null;
  }

  if (wss) {
    const server = wss;
    wss = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (httpServer) {
    const server = httpServer;
    httpServer = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (sessions.size > 0) {
    const transports = [...sessions.values()];
    sessions.clear();
    await Promise.all(transports.map((transport) => transport.close().catch(() => {})));
  }

  setStatus({ running: false, extensionConnected: false });
}
