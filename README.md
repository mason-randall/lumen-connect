# Lumen + Softmax Connect

This repo has two parts:

- **Softmax Connect**, an embed SDK. You add one script tag to a site, and the site gets an agent that can see the
  page and use it through the page's own controls (sliders, switches, selects, buttons, file inputs). You can teach
  it by doing the task yourself while it watches, and it keeps what it learns as a versioned policy. Press
  **⌃⇧** (Control+Shift) on the page to open the Softmax overlay, which lists your apps, your agent's policies and
  some sample friends.
- **Lumen**, a sample photo editor that uses Connect. Lumen has no agent code of its own. The agent finds its
  controls from the HTML.

```html
<script src="http://localhost:7460/connect.js" data-site="lumen" data-nav="agent" data-wave="particles" async></script>
```

| Attribute | |
| --- | --- |
| `data-site` | The site's id on Connect (registered in `server/sites.ts`). Required. |
| `data-position` | Where the nav sits: `bottom-right` (default), `top-right`, `bottom-left`, `top-left`. |
| `data-nav` | `agent` shows only your agent: a circle you can drag anywhere, with the arrow keys too. It stays where you leave it. Without this attribute you get the full nav. |
| `data-wave` | How your agent looks: `lines` (a soundwave, the default) or `particles` (dots that also fly to what it looks at and touches). Lumen uses `particles`. |
| `data-look` | The particles' colors: `sand` (default), `aurora`, `mono`, `lime` or `voice`. |
| `data-client` | The Softmax client the full nav's links open (default `http://localhost:5173`). |

## Requirements

- **Node 22 or newer**, and npm.
- **A model endpoint** for the agent, compatible with the Anthropic Messages API (see [The model](#the-model)).
  Without one, the page, the editor, the agent's circle and the overlay still work, but the agent can't answer.
- **macOS**, only for two of Lumen's features: developing camera raws (ARW, CR2/CR3, NEF, RAF, DNG…) with Apple's
  raw engine, and finding the subject and faces with Apple Vision. Both use the Swift helpers in
  `sites/lumen/server/`, which the server compiles with `swiftc` (Xcode's command line tools) the first time they're
  needed. On other systems, Lumen still opens and edits JPEG, PNG and WebP photos. Its subject mask is unavailable,
  but the sky, radial and linear masks still work. Face positions for the bundled photos come from
  `sites/lumen/faces.json`.

## Run it

```sh
npm install
npm run dev
```

The server starts two things:

| URL | |
| --- | --- |
| http://localhost:7463 | **Lumen**. Open this one. |
| http://localhost:7460 | Connect: `connect.js` and its API. Lumen loads the script from here. |

Each one runs on its own port, so Lumen is on a different origin from Connect, as a real site would be. Set
`CONNECT_PORT` to move Connect off 7460. Lumen's port is set in `server/sites.ts`.

In Lumen:

- Edit the photo with the panel on the right. **Open photo** opens your own photos or raws.
- Click the circle at the bottom left to open your agent, then ask it for something, e.g. "make it warmer".
- Press **⌃⇧** to open the overlay.
- Click the grad cap on the agent's circle to teach it. Then do the edit yourself and say why as you go. The browser
  asks to share the tab. When you finish, the lesson becomes the next version of its policy. The **Policy** tab in
  the agent's panel lists the versions and runs **Practice**: two versions edit the photos in
  `sites/lumen/practice/`, and a judge compares the results against your coaching.

### The model

The agent calls `POST {CONNECT_MODEL_URL}/v1/messages` with an `x-api-key` header and `anthropic-version: 2023-06-01`.

| Variable | Default | |
| --- | --- | --- |
| `CONNECT_MODEL_URL` | `http://127.0.0.1:7440` | The base URL of the Messages API endpoint. The default assumes a local proxy to Claude listening on that port. |
| `CONNECT_MODEL_KEY` | `claude-code-local` | Sent as `x-api-key`. |
| `CONNECT_MODEL` | `claude-opus-5-5` | The model id. |

To use the Anthropic API directly:

```sh
CONNECT_MODEL_URL=https://api.anthropic.com CONNECT_MODEL_KEY=sk-ant-... npm run dev
```

The agent sends screenshots of the page, so the model must accept image input.

### Data

Connect saves its state in `./data`, which is created on first run and ignored by git. The state includes variants,
the agent's code changes, policy versions, coaching sessions and their recordings, practice results, and Lumen's
cached analyses. Set `CONNECT_DATA_DIR` to put it elsewhere, or delete the folder to start over.

## Check it

```sh
npm run typecheck
npm test
```

The tests use [Vitest](https://vitest.dev). The raw-developer tests that need the Swift helpers run only on macOS.

## What's where

| Path | |
| --- | --- |
| `src/connect.ts` | The embed. It renders the nav or the agent's circle, the Liquid panel and the agent's panel inside a shadow root. |
| `src/overlay.ts` | The ⌃⇧ overlay. |
| `src/orb.ts` | Places the agent-only circle, handles dragging it, and picks which way its panel opens. |
| `src/agent/controls.ts` | Finds a page's controls from its HTML (range → slider, checkbox → switch, select → choice, button, file, link; canvas/img/video → views) and drives them with real events. |
| `src/agent/vision.ts` | Takes the agent's pictures: a JPEG of a view, or of part of it. |
| `src/agent/presence.ts` | Shows the agent on the page: what it touches, what it looks at, and what it says, with a synthesized voice. |
| `src/agent/render/` | The agent's two looks, soundwave and particles. |
| `src/voice/` | The agent's babble voice and its timing. |
| `src/agent/operator.ts` | The agent's loop: look, ask the model, act, repeat. On a site that shares its code, it can also change the code. |
| `src/agent/coach.ts`, `panel.ts`, `practice.ts` | Teaching, the agent's panel (Chat, Coach, Policy), and practice between policy versions. |
| `src/patches.ts`, `src/outline.ts` | Liquid variants (safe page patches) and the page outline the agent and the simulated visitors read. |
| `server/server.ts` | The dev server: the `connect.js` bundle (built with esbuild), the API, and the sites. |
| `server/sites.ts` | The registered sites. |
| `server/operator.ts`, `server/policies.ts`, `server/coworld.ts` | The prompts: the agent's steps and code changes, policies (analysis, candidates, the judge), and the first-click visitor test. |
| `sites/lumen/` | Lumen: `index.html`, `app.js` (the editor), `engine.js` (WebGL rendering) and `server/` (its raw and Vision helpers). |

The API answers only the registered sites' own origins (CORS). Connect also supports a site-as-coworld loop: a site
owner sets tasks, simulated visitors take a first-click test, and the agent proposes page variants. Lumen has no
tasks, so this loop doesn't appear in the sample. `test/server.test.ts` exercises it through the API.

## Photo credits

The photos in `sites/lumen/` are from Unsplash. See [CREDITS.md](CREDITS.md).
