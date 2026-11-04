# Cross-tool panel entries

pstack's panels compare model families. Claude Code's `Agent` tool runs only Claude, and Codex's
`spawn_agent` runs only GPT, so a panel entry whose first token is `codex` or `claude` runs the
other vendor's CLI as one member. It counts toward the fan-out like any other entry.

- Claude Code reads `codex <model> <effort>` from `.claude/rules/pstack-models.md`.
- Codex reads `claude <model> <effort>` from `.agents/pstack/codex-models.md`.

## Brief

The CLI starts with no parent history. Write the brief you would give a subagent to a file from
`mktemp`, outside the repo. Make it self-contained: the goal, the paths, the base ref or diff
command, the constraints, the output shape, and whether the member may edit files.

Start the CLI in the background next to the other members. Its last message is that member's
result. Read it from the output file, never from the raw log.

## Read-only members

Interrogate reviewers, architect runners, and the arena cross-judge only read.

From Claude Code:

```sh
codex exec -m <model> -c model_reasoning_effort=<effort> -s read-only --ephemeral \
  -C "$PWD" -o "$out" - < "$brief"
```

From Codex:

```sh
claude -p --model <model> --effort <effort> --disallowedTools Edit Write NotebookEdit \
  --output-format text < "$brief" > "$out"
```

The Claude CLI needs the network and writes to `~/.claude`, so run it outside the Codex sandbox
with escalated permissions. It keeps `Bash`, so the brief says "do not edit files", and you check
`git status` afterward.

## Writing members

Arena runners write code. Give each one its own worktree off the base ref, such as
`git worktree add .claude/worktrees/arena-<slug>-<n> -b arena/<slug>-<n> <base>`, and run
`pnpm install` there.

From Claude Code:

```sh
codex exec -m <model> -c model_reasoning_effort=<effort> -s workspace-write \
  -c sandbox_workspace_write.network_access=true --ephemeral -C "$worktree" \
  -o "$out" - < "$brief"
```

From Codex, outside the sandbox:

```sh
(cd "$worktree" && claude -p --model <model> --effort <effort> --permission-mode acceptEdits \
  --allowedTools Bash --output-format text < "$brief" > "$out")
```

Compare members by their worktree diffs and their output files. Remove each worktree when the
arena is done.

## Failure

If the CLI is missing, signed out, or exits non-zero, put one line in your reply:
`Cross-tool member skipped: <entry>. <reason>.` Then run that slot on the session model so the
fan-out keeps its size. Do not retry the CLI.
