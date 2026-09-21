# Security Policy

## Reporting a vulnerability

Please report security problems privately, by email to **security@venut.tech**. Do not open a
public GitHub issue, pull request or discussion for them.

Useful things to include:

- what you found and why it is a security problem;
- the version or commit, your operating system and Node.js version;
- the MCP client you used, and the tool call or slug that triggered it;
- steps to reproduce, and the response that caused the behaviour if you have it.

Please do **not** send us anything from your own accounts: this server needs no credentials, so a
report never needs a cookie, a session or a purchase record. A captured page or API response is
enough, with any signed media URL removed.

We read every report and will reply once we have looked at it. This is a small experimental
open-source project maintained on a best-effort basis: there is no guaranteed response or fix
time. We will keep you informed while a fix is being worked on, and credit you in the release
notes if you wish.

## Supported versions

The project is pre-1.0. Security fixes are made on the latest version only.

## What counts

This server runs locally, takes slugs from an MCP client, and makes anonymous read-only requests
to Bandcamp. Examples of issues we want to hear about:

- any way to make it fetch a host other than `bandcamp.com` or `*.bandcamp.com` — through a slug,
  a redirect, or a URL inside a Bandcamp response;
- a stream, download or purchase URL reaching a tool result, through any field;
- text from a Bandcamp page reaching the model with markup, control or invisible characters
  intact, or uncapped in length;
- input from a page or API response that crashes the server, hangs it, or makes it consume
  memory or CPU without bound;
- anything written to stdout other than the MCP protocol itself, or a credential, token or
  personal path appearing in output, logs or fixtures.

A crafted bio or description that talks your assistant into something is a real risk and is
described in the README's Known limitations: the text is sanitized and labelled as untrusted data,
which reduces it but cannot remove it. A report that shows the sanitizing or labelling failing is
in scope; the general fact that models can be persuaded by the text they read is not.

Problems in your MCP client, in the model provider it talks to, or in Bandcamp itself are out of
scope for this project; please report those to their maintainers. If you believe this project is
using Bandcamp's endpoints in a way Bandcamp objects to, that is not a vulnerability report —
please open an issue, or write to the same address, and we will act on it.
