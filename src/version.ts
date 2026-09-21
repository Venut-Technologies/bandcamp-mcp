import { createRequire } from "node:module";

// The package version, read from package.json at runtime so serverInfo and the
// User-Agent follow `npm version` with no source edit. "../package.json"
// resolves from both src/ (tsx, vitest) and dist/ (the built bin), and npm
// always ships package.json in the tarball.
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
