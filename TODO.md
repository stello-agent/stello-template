# Post-Publish TODO

## After the next `@stello-ai/*` release

- Replace the template's local DevTools persistence compatibility layer in [`src/bootstrap.ts`](/Users/bytedance/Github/stello-template/src/bootstrap.ts) with the official `stateStore` support exported by `@stello-ai/devtools`.
- Remove the local `LocalDevtoolsPersistedState` and `LocalDevtoolsStateStore` types once `@stello-ai/devtools` publishes the corresponding public types.
- Remove the local `SessionMessageWithToolCalls` compatibility type once `@stello-ai/session` publishes `Message.toolCalls` in the template-consumed package version.
- Re-run the template against the newly published packages and verify:
  - DevTools prompt / LLM / tool toggle / skill toggle persistence still restores after restart.
  - `stello_create_session` still creates child sessions with assistant kickoff messages.
  - tool-call history still survives restart without breaking multi-turn follow-up.
