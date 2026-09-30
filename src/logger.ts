// Minimal logging shim that replaces `electron-log` in the standalone host.
// Everything goes to stderr so stdout stays reserved for the MCP stdio
// transport (which the SDK writes JSON-RPC to). Keeping the `.scope(name)`
// call shape lets the bridge code port over without touching its log sites.
type Logger = {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope: string): Logger {
  const emit = (level: "info" | "warn" | "error", message: string, args: unknown[]): void => {
    const suffix = args.length ? " " + args.map(stringify).join(" ") : "";
    process.stderr.write(`[octolimb:${scope}] ${level} ${message}${suffix}\n`);
  };
  return {
    info: (message, ...args) => emit("info", message, args),
    warn: (message, ...args) => emit("warn", message, args),
    error: (message, ...args) => emit("error", message, args),
  };
}
