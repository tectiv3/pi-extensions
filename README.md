# pi-extensions

pi coding-agent extensions, TypeScript, loaded directly by pi (no build step).

- **`subagent/`** — subagent tool: delegates tasks to specialized agents with isolated context
  windows. Single, parallel (max 8 tasks / 4 concurrent), and chain modes; persistence and
  resume of interrupted runs. See `subagent/README.md` for structure and limitations.
- **`ask-user-question/`** — structured question tool: single- and multi-question prompts with
  typed option pages, `allowOther` free-text option.

Install by symlinking each extension directory into your agent dir:

```sh
ln -s "$PWD/subagent" ~/.pi/agent/extensions/subagent
ln -s "$PWD/ask-user-question" ~/.pi/agent/extensions/ask-user-question
```

Type-checks against host pi package stubs in `types.d.ts`; see `AGENTS.md` for the check
commands and baseline rules.
