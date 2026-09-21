// Usage: node scripts/handshake-check.mjs <command> [args...]
//
// Starts an MCP server the way an MCP client does (the command and its
// arguments, no shell) and checks one stdio session end to end:
// - initialize answers with serverInfo {name: "bandcamp-mcp", version: this
//   package's version};
// - tools/list lists exactly the five tools;
// - closing stdin ends the server with exit code 0;
// - nothing but JSON-RPC ever reaches stdout.
// Exit code 0 when all of that holds within 20 s, 1 otherwise. Node built-ins
// only, so it runs next to an installed tarball without the repo's
// dependencies. No network: the session never calls a tool.
//
// CI's `package` job runs it against the bin npm installed from the packed
// tarball, and against the README's launch commands (.github/workflows/ci.yml).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const TIMEOUT_MS = 20_000;
const PROTOCOL_VERSION = "2025-06-18";
const EXPECTED_TOOLS = [
  "bandcamp_browse_tag",
  "bandcamp_get_album",
  "bandcamp_get_artist",
  "bandcamp_get_track",
  "bandcamp_search",
];
const EXPECTED_SERVER_INFO = {
  name: "bandcamp-mcp",
  version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version,
};

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error("usage: node scripts/handshake-check.mjs <command> [args...]");
  process.exit(1);
}
const commandLine = [command, ...args].join(" ");

// Node refuses to spawn a Windows .cmd/.bat file (such as npm's bin shim)
// without a shell. cmd.exe reads a "/" in an unquoted relative path as a
// switch, so the shim's path is made absolute and every part quoted.
function start() {
  const stdio = ["pipe", "pipe", "pipe"];
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const line = [resolve(command), ...args].map((part) => `"${part}"`).join(" ");
    return spawn(line, { shell: true, stdio });
  }
  return spawn(command, args, { stdio });
}

const child = start();
let serverStderr = "";
child.stderr.setEncoding("utf-8").on("data", (chunk) => (serverStderr += chunk));
// EPIPE when the server is already gone; the close handler reports that.
child.stdin.on("error", () => {});

function fail(message) {
  console.error(`handshake-check: FAIL: ${message}`);
  if (serverStderr.trim() !== "") console.error(`server stderr:\n${serverStderr.trimEnd()}`);
  child.kill();
  process.exit(1);
}

const timer = setTimeout(() => fail(`no complete session with "${commandLine}" within ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS);

child.on("error", (err) => fail(`could not start "${commandLine}": ${err.message}`));

// The one request waiting for its response: { id, method, resolve }.
let pending;

createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // Handled below, like any other non-JSON-RPC line.
  }
  if (message?.jsonrpc !== "2.0") fail(`non-JSON-RPC line on stdout: ${JSON.stringify(line)}`);
  if (pending !== undefined && message.id === pending.id) {
    const { resolve: answer } = pending;
    pending = undefined;
    answer(message);
  }
});

const closed = new Promise((resolveClosed) => {
  child.on("close", (code, signal) => {
    const how = code !== null ? `code ${code}` : `signal ${signal}`;
    if (pending !== undefined) fail(`"${commandLine}" exited with ${how} before answering ${pending.method}`);
    resolveClosed(how);
  });
});

function send(message) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

// Resolves with the result; any JSON-RPC error fails the check.
async function request(id, method, params) {
  const answered = new Promise((resolveAnswer) => {
    pending = { id, method, resolve: resolveAnswer };
  });
  send({ id, method, params });
  const response = await answered;
  if (response.error !== undefined || response.result === undefined) {
    fail(`${method} failed: ${JSON.stringify(response.error ?? response)}`);
  }
  return response.result;
}

const initialized = await request(1, "initialize", {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "bandcamp-mcp-handshake-check", version: "0.0.0" },
});
const { serverInfo, protocolVersion } = initialized;
if (serverInfo?.name !== EXPECTED_SERVER_INFO.name || serverInfo?.version !== EXPECTED_SERVER_INFO.version) {
  fail(`serverInfo is ${JSON.stringify(serverInfo)}, expected ${JSON.stringify(EXPECTED_SERVER_INFO)}`);
}
if (typeof protocolVersion !== "string" || protocolVersion === "") {
  fail(`initialize returned no protocolVersion: ${JSON.stringify(initialized)}`);
}
send({ method: "notifications/initialized" });

const { tools } = await request(2, "tools/list", {});
const names = Array.isArray(tools) ? tools.map((tool) => tool?.name).sort() : [];
const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
const unexpected = names.filter((name) => !EXPECTED_TOOLS.includes(name));
if (missing.length > 0 || unexpected.length > 0 || names.length !== EXPECTED_TOOLS.length) {
  fail(
    `tools/list is wrong; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}; ` +
      `listed: ${JSON.stringify(names)}`
  );
}

// Closing stdin is how a client ends a stdio session.
child.stdin.end();
const exit = await closed;
if (exit !== "code 0") fail(`"${commandLine}" exited with ${exit} after stdin closed, expected code 0`);
clearTimeout(timer);

console.log(
  `handshake-check: OK: ${serverInfo.name} ${serverInfo.version} (protocol ${protocolVersion}), ` +
    `tools: ${names.join(", ")}; exited with code 0 after stdin closed`
);
