# annotate: comment on files for your harness

Opens a file in your browser with line numbers. Click or drag line numbers, or highlight text, to leave comments, then press **Send**. Your harness gets every comment with the lines it refers to, and acts on them.

Works on Windows, macOS and Linux. Needs only Node.js (which your harness likely already uses); highlighting git changes also needs git and [difftastic](https://difftastic.wilfred.me.uk). No npm install, no build step. (Mermaid diagrams need an internet connection to load the renderer.)

## Install

Clone or copy this repo somewhere permanent, then in Claude Code:
```
/plugin marketplace add ~/projects/pairprog/annotate        # Windows: C:\path\to\annotate
/plugin install annotate@annotate-tools
```

Or from a terminal: `claude plugin marketplace add <path>` then `claude plugin install annotate@annotate-tools`. Restart your harness. Once pushed to GitHub, others can use `/plugin marketplace add <owner>/<repo>`.

## Use

```
/annotate docs/plan.md
/annotate src/api.ts only answer my questions, don't edit
```

Or just ask: "let me review the plan before you start". Your harness will open it with the skill.

In the browser:

- **Click** a line number to comment on one line; **drag** or **shift-click** for a range.
- **Highlight** text and the comment box opens straight away. (If you are halfway through another comment, a 💬 Comment button appears instead, so your draft is kept.)
- **Git changes**: if the file is in a git repository and has uncommitted changes, a *Changes* bar lets you highlight the **Unstaged**, **Staged** or **All** changes (or turn them **Off**), with +/− counts and ↑ ↓ to jump between them. Changed lines get a green bar, old and removed lines are shown in red without a line number (you can't comment on them), and diagrams with changed source are marked *changed*. The diff comes from [difftastic](https://difftastic.wilfred.me.uk) (`difft`, must be on your PATH), so in code only the tokens that really changed are highlighted. difftastic has no Markdown parser yet, so in `.md` files whole changed lines are highlighted. Staged changes are shown on the file as it is on disk. Your choice is remembered.
- **Markdown** files are highlighted with the colours and rules of [OpenCode](https://opencode.ai)'s default theme (light or dark, following your system). Markers that OpenCode hides (`#`, `**`, backticks, code fences, link brackets) are dimmed instead, so the page still shows the exact source text and line numbers match the file. Fenced code in the languages OpenCode highlights gets its syntax colours.
- **Source files** (`.ts`, `.py`, `.rs`, … — any extension the code highlighter knows, the same list as fenced code blocks in Markdown) get the same token colours for the whole file.
- **Tables** (GFM) are shown as tables that wrap to the window width. Each table row is one source line: click its line number, or highlight text in a cell.
- **Mermaid** blocks are drawn as diagrams. Click a shape (node, group, edge label, note, participant) to comment on it, or use *Comment on the whole diagram*. Your harness gets the block's line range plus the shape and the line where it is defined. *Show source* reveals the block's lines for line comments.
- Untick **Tables & diagrams** to see the plain source instead.
- `Ctrl+Enter` saves a comment, `Esc` cancels. Comments are listed on the right; click one to jump to it.
- Add an optional general comment, then **Send**. With no comments, the button reads **Approve**.
- Comments survive a page refresh until you send them.

## How it works

`annotate.mjs` starts a tiny server bound to `127.0.0.1` on a random port, with a random token in the URL, opens your default browser (`start` on Windows), and waits for you to send. The server runs detached, so if you take longer than ~9 minutes, your harness's call returns `PENDING` and it simply resumes waiting; nothing is lost. Session files live in your temp folder and are deleted once delivered.

Diagrams are drawn in the page by [Pele](https://pele.run) (MIT, no dependencies), loaded from jsDelivr only when the file has a mermaid block, pinned to one version with a Subresource Integrity hash. Offline, the diagram's source is shown instead and you can still comment on its lines.

Pass `--diff off|unstaged|staged|all` to choose which changes are highlighted when the page opens (otherwise *All*, or your last choice). Your harness is told which changes you were viewing.

Environment options: `ANNOTATE_NO_OPEN=1` (print the URL instead of opening a browser), `ANNOTATE_WAIT_MS` (how long each wait call blocks).

## Develop

```
mise install        # Node 24
mise run test       # Markdown + git-changes unit tests, end-to-end smoke test (needs git and difft)
mise run try README.md
```
