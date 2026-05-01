# RefCheck AI - Soccer Frame Review

AI-powered soccer officiating analysis built around the approach that works with only an OpenAI key:

1. Upload a short soccer clip.
2. The browser extracts 5-6 JPEG frames with canvas.
3. GPT-4o reads the frames as one left-to-right timeline.
4. GPT-4o compares the neutral play description to embedded soccer rule context.
5. The app returns a structured verdict: `Fair Call`, `Bad Call`, or `Inconclusive`.

This version is intentionally soccer-only so the prompts and rules stay focused on handball, offside, fouls, penalties, and card severity.

## Why This Approach

GPT-4o can analyze multiple image inputs in a single request. For a short soccer incident, 5-6 well-chosen frames usually capture the important decision context: ball location, player position, contact point, arm position, defensive line, and player trajectory.

The app does not upload the full video to OpenAI. It extracts frames in the browser and sends those frames through a local Vite proxy.

## Requirements

- Node.js 18 or newer
- pnpm
- An OpenAI API key

If you do not have pnpm:

```bash
npm install -g pnpm
```

## Setup

```bash
cd refcheck-soccer-ai
pnpm install
cp .env.example .env
```

Edit `.env`:

```bash
OPENAI_API_KEY=sk-your-key-here
VITE_OPENAI_MODEL=gpt-4o
```

You can try `gpt-4o-mini` for cheaper testing, but `gpt-4o` is the better default for hard visual calls.

## Run

```bash
pnpm dev
```

Open the local URL Vite prints, usually:

```text
http://localhost:5173
```

Sign in with any username/password. Use demo clips to test the UI without API calls, or upload a short soccer clip for live analysis.

## Tips For Better Results

- Keep clips under 10 seconds.
- Enter the incident time when you know it, such as `4.2`; the app samples frames densely around that second.
- Write the original referee call, such as `No handball`, `Penalty awarded`, or `Offside`.
- Use notes to point the model at the dispute, for example `possible contact by defender's left arm`.

## Production Note

The Vite proxy is for local development. For deployment, create a small backend route that forwards requests to `https://api.openai.com/v1/responses` and injects `OPENAI_API_KEY` server-side. Do not expose `OPENAI_API_KEY` in browser code.
