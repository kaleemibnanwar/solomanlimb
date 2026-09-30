#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createOctoLimbMcpServer,
  startHttpBridge,
  startWebSocketRelay,
  stopBridge,
  type StartOptions,
} from "./bridge.js";

function usage(): string {
  return [
    "octolimb — MCP bridge that drives a real Chrome browser via the OctoLimb extension",
    "",
    "Usage:",
    "  octolimb                 stdio MCP server (for Claude Code, Codex, etc.) + WS relay",
    "  octolimb --http          Streamable HTTP MCP server on 127.0.0.1:32527/mcp + WS relay",
    "  octolimb --http-port N   override the HTTP port (default 32527)",
    "  octolimb --ws-port N     override the WebSocket port (default 32528)",
  ].join("\n");
}

function parseArgs(argv: string[]): StartOptions & { http: boolean } {
  let http = false;
  const options: StartOptions = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--http") {
      http = true;
    } else if (arg === "--stdio") {
      http = false;
    } else if (arg === "--http-port") {
      options.httpPort = Number(argv[++i]);
    } else if (arg === "--ws-port") {
      options.wsPort = Number(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      process.stderr.write(usage() + "\n");
      process.exit(0);
    }
  }
  return { ...options, http };
}

async function main(): Promise<void> {
  const { http, ...options } = parseArgs(process.argv);

  if (http) {
    // The HTTP server and WS relay are active listeners, so the process
    // stays alive until stopped.
    await startHttpBridge(options);
    return;
  }

  // stdio mode: start the WS relay for the extension, then serve MCP over
  // stdin/stdout. Logging already goes to stderr, so stdout stays reserved
  // for the MCP JSON-RPC transport.
  await startWebSocketRelay(options);
  const server = createOctoLimbMcpServer();
  const transport = new StdioServerTransport();

  transport.onclose = () => {
    void stopBridge().then(() => process.exit(0));
  };
  process.stdin.on("end", () => {
    void stopBridge().then(() => process.exit(0));
  });

  await server.connect(transport);
}

process.on("SIGINT", () => {
  void stopBridge().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void stopBridge().then(() => process.exit(0));
});

main().catch((error) => {
  // Fatal startup error: report to stderr (never stdout) and exit.
  process.stderr.write(`[octolimb] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
