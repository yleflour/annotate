---
name: annotate
description: Let the user review a file (a plan, spec, doc or code) in their browser and leave line-anchored comments for you. Use when the user asks to review, annotate, comment on or give feedback on a file before you continue, or after you write a plan or document they should check.
---

# Annotate a file

Opens a local browser page showing the file with line numbers. The user clicks or drags line numbers, or highlights text, to leave comments, then presses Send. The comments come back to you on stdout.

Run with the Bash tool, `timeout: 600000`:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/annotate/annotate.mjs" "<path to file>"
```

Output starts with one of:

- `ANNOTATIONS for <file>`: numbered comments, each with its line range and the lines or selected text it refers to. Address every one; make the edits unless the user only wanted feedback. Report back per comment.
- `... approved it with no comments`: continue.
- `PENDING <id>`: the user is still annotating. Immediately run `node "${CLAUDE_PLUGIN_ROOT}/skills/annotate/annotate.mjs" --wait <id>` (timeout 600000).
- `OPEN_FAILED <id>`: give the user the printed URL, then run the `--wait` command.
- `CANCELLED` / `ERROR`: tell the user and stop.

Line numbers refer to the file as it was when the page loaded, so apply edits from the bottom of the file up if line positions matter.
