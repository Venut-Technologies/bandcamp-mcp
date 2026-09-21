// scripts/handshake-check.mjs is the check CI's `package` job runs against the
// bin npm installs from the packed tarball (.github/workflows/ci.yml). Here it
// runs against the server from source, and against stand-in servers that are
// broken in one way each, so a check that passes anything can't slip through.
// No network: a session only initializes and lists tools.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHECK_SCRIPT = join(REPO_ROOT, "scripts", "handshake-check.mjs");
const RUN_TIMEOUT_MS = 30_000;

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
  version: string;
};

// A line-delimited JSON-RPC server that answers like bandcamp-mcp, except for
// what its mode (argv[2]) breaks.
const FAKE_SERVER = `
import { createInterface } from "node:readline";
const mode = process.argv[2];
if (mode === "crash") process.exit(3);
if (mode === "bad-exit") process.stdin.on("end", () => process.exit(1));
const tools = ["bandcamp_search", "bandcamp_get_album", "bandcamp_get_artist", "bandcamp_get_track", "bandcamp_browse_tag"];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    if (mode === "noisy-stdout") console.log("server started");
    const serverInfo = { name: "bandcamp-mcp", version: mode === "wrong-version" ? "0.0.0-other" : ${JSON.stringify(version)} };
    send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo } });
  } else if (method === "tools/list") {
    const listed = mode === "four-tools" ? tools.slice(0, 4) : mode === "duplicate-tool" ? [...tools, tools[0]] : tools;
    send({ id, result: { tools: listed.map((name) => ({ name, inputSchema: { type: "object" } })) } });
  }
});
`;

type CheckRun = { code: number | null; stdout: string; stderr: string };

function runCheck(command: string[]): Promise<CheckRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHECK_SCRIPT, ...command], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("scripts/handshake-check.mjs", () => {
  let tempDir: string;
  let fakeServer: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bandcamp-mcp-handshake-"));
    fakeServer = join(tempDir, "fake-server.mjs");
    writeFileSync(fakeServer, FAKE_SERVER);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes the real server", { timeout: RUN_TIMEOUT_MS }, async () => {
    const run = await runCheck([process.execPath, "--import", "tsx", "src/index.ts"]);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain(`OK: bandcamp-mcp ${version}`);
    expect(run.code).toBe(0);
  });

  it("passes a stand-in that answers correctly", { timeout: RUN_TIMEOUT_MS }, async () => {
    const run = await runCheck([process.execPath, fakeServer, "ok"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
  });

  it.each([
    ["crash", "exited with code 3 before answering initialize"],
    ["four-tools", "missing: bandcamp_browse_tag"],
    ["duplicate-tool", 'listed: ["bandcamp_browse_tag","bandcamp_get_album","bandcamp_get_artist","bandcamp_get_track","bandcamp_search","bandcamp_search"]'],
    ["wrong-version", `expected {"name":"bandcamp-mcp","version":"${version}"}`],
    ["noisy-stdout", 'non-JSON-RPC line on stdout: "server started"'],
    ["bad-exit", "exited with code 1 after stdin closed, expected code 0"],
  ])("fails a server whose mode is %s", { timeout: RUN_TIMEOUT_MS }, async (mode, reason) => {
    const run = await runCheck([process.execPath, fakeServer, mode]);
    expect(run.stderr).toContain(reason);
    expect(run.stdout).toBe("");
    expect(run.code).toBe(1);
  });

  it("fails when the command can't be started", { timeout: RUN_TIMEOUT_MS }, async () => {
    const run = await runCheck([join(tempDir, "no-such-bin")]);
    expect(run.stderr).toContain("could not start");
    expect(run.code).toBe(1);
  });

  it("fails without a command", { timeout: RUN_TIMEOUT_MS }, async () => {
    const run = await runCheck([]);
    expect(run.stderr).toContain("usage: node scripts/handshake-check.mjs <command> [args...]");
    expect(run.code).toBe(1);
  });
});
