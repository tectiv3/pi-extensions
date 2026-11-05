---
description: Scout gathers context, planner creates implementation plan (no implementation)
---
Execute this workflow as two separate subagent calls, in order:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the scout result

Each step is its own subagent call with `background: false`: run one, read its result, then dispatch the next with that output included in its task. Do NOT implement - just return the plan.
