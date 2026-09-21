// The built bin as a real process. npm installs a bin as a symlink
// (node_modules/.bin/bandcamp-mcp → ../bandcamp-mcp/dist/index.js), and Node
// then sets process.argv[1] to the symlink while import.meta.url is the real
// path, so an "am I the main module?" guard comparing the two never fires and
// the server exits without starting. The bin is launched here through such a
// symlink, the way npx and a global install launch it. No network: the session
// only initializes and lists tools.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 20_000;
// Per step, so a silent server fails with a message instead of the test timeout.
const STEP_TIMEOUT_MS = 5_000;

const ON_WINDOWS = process.platform === "win32";
const WINDOWS_SKIP_REASON =
  "POSIX only: on Windows npm installs a .cmd shim rather than a symlink, and creating a symlink needs Developer Mode or admin rights";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
  version: string;
};

type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; result?: Record<string, unknown> };

type BinSession = {
  child: ChildProcessWithoutNullStreams;
  stdoutLines: string[];
  send: (message: object) => void;
  // Resolves with the response to request `id`; rejects if the process closes
  // first or nothing arrives within STEP_TIMEOUT_MS.
  response: (id: number) => Promise<JsonRpcMessage>;
  // Resolves once the process has exited and its stdio has closed.
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function startBin(binPath: string): BinSession {
  const child = spawn(process.execPath, [binPath], { stdio: ["pipe", "pipe", "pipe"] });
  // EPIPE once the bin has exited; that failure is reported by response/closed.
  child.stdin.on("error", () => {});
  const stdoutLines: string[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
  const pending = new Map<number, (message: JsonRpcMessage) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    stdoutLines.push(line);
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // Kept in stdoutLines; the test fails on any non-JSON-RPC line.
    }
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal }))
  );
  const describeOutput = () => `stdout: ${JSON.stringify(stdoutLines.join("\n"))}, stderr: ${JSON.stringify(stderr)}`;

  return {
    child,
    stdoutLines,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    response: (id) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no response to request ${id} within ${STEP_TIMEOUT_MS}ms; ${describeOutput()}`)),
          STEP_TIMEOUT_MS
        );
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        void closed.then(({ code, signal }) => {
          clearTimeout(timer);
          reject(new Error(`bin exited (code ${code}, signal ${signal}) before answering request ${id}; ${describeOutput()}`));
        });
      }),
    closed,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

describe("bandcamp-mcp bin", () => {
  let tempDir: string | undefined;
  let binPath: string;

  beforeAll(() => {
    if (ON_WINDOWS) return;
    // Always a fresh build: a stale dist/ would test old code.
    try {
      execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe", timeout: BUILD_TIMEOUT_MS });
    } catch (err) {
      const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`npm run build failed:\n${stdout?.toString() ?? ""}${stderr?.toString() ?? ""}`, { cause: err });
    }
    tempDir = mkdtempSync(join(tmpdir(), "bandcamp-mcp-bin-"));
    binPath = join(tempDir, "bandcamp-mcp");
    symlinkSync(join(REPO_ROOT, "dist", "index.js"), binPath);
  }, BUILD_TIMEOUT_MS + 10_000);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves an MCP session over stdio when launched through a bin symlink", { timeout: SESSION_TIMEOUT_MS }, async (ctx) => {
    ctx.skip(ON_WINDOWS, WINDOWS_SKIP_REASON);
    const bin = startBin(binPath);
    ctx.onTestFinished(() => {
      bin.child.kill();
    });

    bin.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "bandcamp-mcp-bin-test", version: "0.0.0" },
      },
    });
    expect(await bin.response(1)).toMatchObject({
      result: { protocolVersion: LATEST_PROTOCOL_VERSION, serverInfo: { name: "bandcamp-mcp", version } },
    });

    bin.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    bin.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await bin.response(2);
    expect(listed).toMatchObject({ result: { tools: expect.any(Array) } });
    const tools = listed.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "bandcamp_browse_tag",
      "bandcamp_get_album",
      "bandcamp_get_artist",
      "bandcamp_get_track",
      "bandcamp_search",
    ]);

    // Closing stdin ends the session; the server must then exit on its own.
    bin.child.stdin.end();
    expect(await withTimeout(bin.closed, STEP_TIMEOUT_MS, "bin did not exit after stdin closed")).toEqual({
      code: 0,
      signal: null,
    });

    // stdout is the protocol channel: anything else printed there (a stray
    // console.log) corrupts the session.
    expect(bin.stdoutLines).toHaveLength(2);
    for (const line of bin.stdoutLines) {
      expect(JSON.parse(line), line).toMatchObject({ jsonrpc: "2.0" });
    }
  });
});
