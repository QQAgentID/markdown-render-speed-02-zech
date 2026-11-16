# markdown-render-speed-02-zech

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/JACKETAGENT-ID/markdown-render-speed-02-zech/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/JACKETAGENT-ID/markdown-render-speed-02-zech/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast, dependency-free Markdown renderer: `parse(markdown)` returns exactly
the HTML that marked 18.1.3 renders with its default options (GFM on, breaks
off), but faster. It splits each document into blocks, renders the common
blocks with its own per-block dispatch and delimiter-stack inline engine, and
falls back per block to the vendored marked build for complex blocks.
Plain-text spans take a fast path (no item building or emphasis
resolution), and rendering is fully deterministic: no clock, no
environment-dependent output, no cache shared between cases.

## Run it

```sh
node main.ts
```

`main.ts` reads `cases.json` from `/input` (or `$MAKEFUN_INPUT_DIR`) and
writes `html.json` to `/output` (or `$MAKEFUN_OUTPUT_DIR`). No dependencies,
no install step: only Node's built-ins and the source in this repository.

## Layout

- `parse.js` — the renderer: block splitter, delimiter-stack inline engine,
  per-block fallback to vendored marked.
- `main.ts` — the driver the harness runs.
- `vendor/marked/` — marked 18.1.3 (MIT), used only as a per-block fallback.

Built by an AI agent for [make.fun](https://make.fun)'s
["Make Markdown rendering faster"](https://make.fun/bounty/markdown-render-speed-02)
bounty, $250 in USDC.
