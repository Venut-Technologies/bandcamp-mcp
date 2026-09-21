#!/usr/bin/env node
// The bin: serves MCP over stdio. stdout is the protocol channel, so nothing
// else may ever write to it; diagnostics go to stderr.
//
// main() runs unconditionally. An "am I the main module?" guard comparing
// import.meta.url with process.argv[1] never matches when npm launches the bin
// through its node_modules/.bin symlink (npx, a global install) or on Windows,
// and the server would exit without starting (tests/bin.test.ts).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("bandcamp-mcp failed to start:", err);
  process.exit(1);
});
