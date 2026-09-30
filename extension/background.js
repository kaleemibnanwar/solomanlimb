import { runTool } from "./tools.js";

const WS_URL = "ws://127.0.0.1:32528";
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const ALARM_NAME = "octolimb-reconnect-check";

let socket = null;
let backoffMs = MIN_BACKOFF_MS;
let reconnectTimer = null;

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

function connect() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  let nextSocket;
  try {
    nextSocket = new WebSocket(WS_URL);
  } catch (error) {
    console.warn("[OctoLimb] failed to open WebSocket", error);
    scheduleReconnect();
    return;
  }
  socket = nextSocket;

  socket.addEventListener("open", () => {
    console.log("[OctoLimb] connected to bridge at", WS_URL);
    backoffMs = MIN_BACKOFF_MS;
  });

  socket.addEventListener("message", async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type !== "tool_call") return;
    try {
      const result = await runTool(message.tool, message.args ?? {});
      send({ type: "tool_result", id: message.id, result });
    } catch (error) {
      send({
        type: "tool_error",
        id: message.id,
        error: error && error.message ? error.message : String(error),
      });
    }
  });

  socket.addEventListener("close", () => {
    if (socket === nextSocket) socket = null;
    scheduleReconnect();
  });

  // A WebSocket "error" event is always followed by a "close" event, which
  // is where reconnection is scheduled — nothing else to do here beyond
  // logging for diagnostics.
  socket.addEventListener("error", () => {
    console.warn("[OctoLimb] WebSocket error, will reconnect on close");
  });
}

// Reconnect triggers that make the connection resilient across browser
// restarts and Studio restarts:
// - onStartup / onInstalled: Chrome (re)launching or the extension loading.
// - the periodic alarm: a backstop against the MV3 service worker being
//   suspended mid-backoff (a suspended worker's setTimeout never fires), and
//   against the bridge coming back online after Studio was closed/reopened.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) connect();
});

connect();
