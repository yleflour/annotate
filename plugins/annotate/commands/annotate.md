---
description: Open a file in the browser so you can comment on it, then have Claude act on the comments
argument-hint: <file> [what Claude should do with the comments]
allowed-tools: Bash(node:*), Read, Edit, Write, Glob
---

The user wants to annotate a file and have you act on their comments.

Arguments: $ARGUMENTS

1. Work out which file they mean. The first argument is usually the path; anything after it is an instruction for what to do with the comments. If no file was given, use the file most recently discussed or written in this conversation; if that is unclear, ask.
2. Run this with the Bash tool, quoting the path, and set the Bash `timeout` to 600000:

   node "${CLAUDE_PLUGIN_ROOT}/skills/annotate/annotate.mjs" "<file>"

   It opens the file in the user's browser and blocks until they press Send, then prints their comments.
3. Handle the output:
   - `ANNOTATIONS for ...`: each comment is anchored to a line range (with the lines or the highlighted text). Read the file, then address every comment. Unless the user said otherwise, make the requested changes; when a comment is a question, answer it. Finish with a short list mapping each comment to what you did.
   - `approved it with no comments`: say so briefly and carry on.
   - `PENDING <id>`: the user is still writing. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/annotate/annotate.mjs" --wait <id>` again (timeout 600000). Do not tell them anything first.
   - `OPEN_FAILED`: show the user the URL from the output, then run the `--wait` command.
   - `CANCELLED` or `ERROR`: tell the user in one line and stop.
