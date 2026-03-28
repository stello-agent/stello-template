# Changelog

## Unreleased

### Changed

- upgraded to the published `@stello-ai/core@^0.2.1`, `@stello-ai/devtools@^0.2.1`, and `@stello-ai/session@^0.2.2`
- switched the template to the official `DevtoolsStateStore` API from `@stello-ai/devtools`
- switched the built-in `stello_create_session` path to the official `createSessionTool` API from `@stello-ai/session`
- added `maxContextTokens` to the template LLM spec to match the published OpenAI-compatible adapter contract

### Fixed

- preserved tool-call history in file-backed session records so restarted sessions can continue multi-turn tool use
- kept DevTools persistence without storing `OPENAI_API_KEY`
- aligned child session kickoff behavior so the optional `prompt` becomes the first assistant message in the child session
