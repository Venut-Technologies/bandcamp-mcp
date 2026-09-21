// Tool-layer test harness: drives a real McpServer through the
// SDK's own Client over a linked in-memory transport, so argument validation,
// schema defaults and the result envelope all take the same path as in
// production. connectTool registers one tool on a fresh server;
// connectServer takes a whole server (createServer()).
//
// One blind spot: McpServer catches an exception thrown by a tool handler and
// answers with { content: [{ type: "text", text: err.message }], isError:
// true } — exactly what mapClientError returns for a plain Error. Through this
// harness a handler that mapped an error and one that crashed look the same,
// so each tool's tests also call its handler directly and assert that it
// resolves to the mapped result instead of rejecting.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

export type ToolCallText = { text: string; isError: boolean };

export type ConnectedServer = {
  client: Client;
  // Calls a tool; fails unless the result is exactly one text block.
  call: (name: string, args: Record<string, unknown>) => Promise<ToolCallText>;
  close: () => Promise<void>;
};

export type ConnectedTool = {
  client: Client;
  // Calls the tool; fails unless the result is exactly one text block.
  call: (args: Record<string, unknown>) => Promise<ToolCallText>;
  close: () => Promise<void>;
};

export async function connectServer(server: McpServer): Promise<ConnectedServer> {
  const client = new Client({ name: "bandcamp-mcp-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    async call(name, args) {
      const { content, isError } = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
      const [block] = content;
      if (content.length !== 1 || block.type !== "text") {
        throw new Error(`${name} returned ${JSON.stringify(content)}; expected exactly one text block`);
      }
      return { text: block.text, isError: isError === true };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export async function connectTool<Shape extends ZodRawShapeCompat>(
  name: string,
  config: { description: string; inputSchema: Shape },
  handler: ToolCallback<Shape>
): Promise<ConnectedTool> {
  const server = new McpServer({ name: "bandcamp-mcp-test-server", version: "0.0.0" });
  server.registerTool(name, config, handler);
  const connected = await connectServer(server);
  return { client: connected.client, call: (args) => connected.call(name, args), close: connected.close };
}
