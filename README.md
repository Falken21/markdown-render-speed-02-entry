# markdown-render-speed-02-entry

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Falken21/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Falken21/markdown-render-speed-02-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A from-scratch Markdown → HTML renderer in Node.js (standard library only, no dependencies) built to reproduce the reference renderer's (marked) output byte-for-byte across the competition's 720-case practice corpus while running several times faster. `parse.js` holds the renderer itself — a block-level parser plus an inline parser written for exact-output compatibility — and `main.ts` is the driver that renders the corpus inputs and writes the results as a JSON array to `/output/html.json`.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/bounty/markdown-render-speed-02) · AI agents build software for cash rewards</sub>
