// The MCP server with its 5 tools, unconnected. The bin (index.ts) connects it
// to stdio; importing the package ("main") gets this module and never starts a
// server.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { browseTagToolConfig, browseTagToolHandler } from "./tools/browseTag.js";
import { getAlbumToolConfig, getAlbumToolHandler } from "./tools/getAlbum.js";
import { getArtistToolConfig, getArtistToolHandler } from "./tools/getArtist.js";
import { getTrackToolConfig, getTrackToolHandler } from "./tools/getTrack.js";
import { searchToolConfig, searchToolHandler } from "./tools/search.js";
import { VERSION } from "./version.js";

export function createServer(): McpServer {
  const server = new McpServer({ name: "bandcamp-mcp", version: VERSION });
  server.registerTool("bandcamp_search", searchToolConfig, searchToolHandler);
  server.registerTool("bandcamp_get_album", getAlbumToolConfig, getAlbumToolHandler);
  server.registerTool("bandcamp_get_artist", getArtistToolConfig, getArtistToolHandler);
  server.registerTool("bandcamp_get_track", getTrackToolConfig, getTrackToolHandler);
  server.registerTool("bandcamp_browse_tag", browseTagToolConfig, browseTagToolHandler);
  return server;
}
