# stello-template

A starter template for building a complete Stello demo app around `@stello-ai/devtools`.

This template is intentionally scenario-neutral. It provides orchestration and DevTools wiring, not a built-in business persona.

## What You Get

- `StelloAgent` wired to real `@stello-ai/session`
- file-backed memory and session tree persistence
- DevTools with chat, topology, prompts, L2, insights, tool toggles, skill toggles, and manual integration
- runtime LLM switching from DevTools
- built-in `stello_create_session` and `save_note` tools
- persisted DevTools settings and session system prompts

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Open:

```text
http://127.0.0.1:4800
```

If you only want to verify bootstrapping:

```bash
DEMO_DRY_RUN=1 pnpm dry-run
```

## Configure Your App

Edit `src/app-spec.ts`:

- app name and root label
- main system prompt
- child session prompt factory
- consolidate / integrate prompts
- default LLM config
- scheduler cadence
- custom tools
- custom skills

The defaults are placeholders only. Replace them with your own business-specific prompts and tools.

## Files

- `src/app-spec.ts`: the main app spec users should edit
- `src/bootstrap.ts`: reusable wiring for agent, sessions, memory, tools, and DevTools providers
- `src/main.ts`: startup entry

## Environment Variables

```bash
OPENAI_BASE_URL=https://api.minimaxi.com/v1
OPENAI_API_KEY=your_key
OPENAI_MODEL=MiniMax-M2.7
DEMO_HOST=127.0.0.1
DEVTOOLS_PORT=4800
```

## Notes

- The template intentionally exposes only global consolidate/integrate prompts in DevTools.
- Session-specific system prompt and insights editing are enabled.
- DevTools changes are persisted by default under `./tmp/stello-app`.
- Persisted DevTools state includes global consolidate/integrate prompts, LLM config, tool toggles, and skill toggles.
- `OPENAI_API_KEY` is not persisted to disk.
- Session-level system prompt edits are also persisted per session.
- Persistence lives under `./tmp/stello-app` by default.
- Built-in `stello_create_session` accepts `label`, optional `systemPrompt`, and optional `prompt`. The `prompt` is written as the child session's first assistant kickoff message.
