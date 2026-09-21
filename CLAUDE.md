# Project rules

## Committing

When a task is finished, always end your final message by asking whether to commit it (e.g. "Want me to commit this?"). Do this every time, for every completed task, including small ones.

- Ask; don't commit until the user says yes.
- When committing, stage only the files touched for that task (`git add <path>`, never `git add -A`) — parallel sessions can leave unrelated edits in the tree.
- Never push, tag, or run destructive git commands unless explicitly asked.
