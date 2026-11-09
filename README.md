# annotate: comment on files for Claude Code

Opens a file in your browser with line numbers. Click or drag line numbers, or highlight text, to leave comments, then press **Send**. Claude gets every comment with the lines it refers to, and acts on them.

Works on Windows, macOS and Linux. Needs only Node.js (which Claude Code already uses). No npm install, no build step.

## Install

Clone or copy this repo somewhere permanent, then in Claude Code:

```
/plugin marketplace add ~/projects/pairprog/annotate        # Windows: C:\path\to\annotate
/plugin install annotate@annotate-tools
```

Or from a terminal: `claude plugin marketplace add <path>` then `claude plugin install annotate@annotate-tools`. Restart Claude Code. Once pushed to GitHub, others can use `/plugin marketplace add <owner>/<repo>`.

## Use

```
/annotate docs/plan.md
/annotate src/api.ts only answer my questions, don't edit
```

Or just ask: "let me review the plan before you start". Claude will open it with the skill.

In the browser:

- **Click** a line number to comment on one line; **drag** or **shift-click** for a range.
- **Highlight** text, then press the 💬 Comment button.
- `Ctrl+Enter` saves a comment, `Esc` cancels. Comments are listed on the right; click one to jump to it.
- Add an optional general comment, then **Send**. With no comments, the button reads **Approve**.
- Comments survive a page refresh until you send them.

## How it works

`annotate.mjs` starts a tiny server bound to `127.0.0.1` on a random port, with a random token in the URL, opens your default browser (`start` on Windows), and waits for you to send. The server runs detached, so if you take longer than ~9 minutes, Claude's call returns `PENDING` and Claude simply resumes waiting; nothing is lost. Session files live in your temp folder and are deleted once delivered.

Environment options: `ANNOTATE_NO_OPEN=1` (print the URL instead of opening a browser), `ANNOTATE_WAIT_MS` (how long each wait call blocks).

## Develop

```
mise install        # Node 24
mise run test       # end-to-end smoke test
mise run try README.md
```
