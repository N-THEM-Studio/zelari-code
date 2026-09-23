---
kind: doc
id: uploaded-index-html-plain-language-reading
date: 2026-09-06
tags: [upload, index-html, unrealsystemmcp]
---
# What `.zelari/uploads/937fc76fe2dad3bc-index.html` says

This file is a **minimal Vite/React SPA shell**, not a product spec and not Zelari Code itself.

## Literal content
- Document title: **UnrealSystemMCP — Blueprint & gameplay-system authoring over MCP**
- Empty `<div id="root">` (React mount)
- Module entry: `/src/main.tsx`
- No inline JS, no CSS, no copy beyond the `<title>`

## Meaning
It names a **separate** idea: an MCP server/app for authoring Unreal Engine Blueprints and gameplay systems. The HTML does not implement that product; it only bootstraps a frontend that would live in `src/main.tsx` (not present in this upload).

## Not this repo
Zelari Code’s real entrypoints are `bin/zelari-code.js`, `src/cli/`, `packages/core`. This upload is an attached reference, not an in-tree `index.html` feature.

## Assumption
User asked “cosa dice?” = explain the file. No implementation requested.
