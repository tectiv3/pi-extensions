---
description: Full implementation workflow - scout gathers context, planner creates plan, worker implements
---
Execute this workflow as three separate subagent calls, in order:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the scout result
3. Finally, use the "worker" agent to implement the plan from the planner result

Each step is its own subagent call: run one, read its result, then dispatch the next with that output included in its task.
