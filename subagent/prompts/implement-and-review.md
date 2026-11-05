---
description: Worker implements, reviewer reviews, worker applies feedback
---
Execute this workflow as three separate subagent calls, in order:

1. First, use the "worker" agent to implement: $@
2. Then, use the "reviewer" agent to review the implementation from the worker result
3. Finally, use the "worker" agent to apply the feedback from the review

Each step is its own subagent call with `background: false`: run one, read its result, then dispatch the next with that output included in its task.
