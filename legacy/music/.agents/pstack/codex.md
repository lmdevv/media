# pstack in Codex

pstack skills use Cursor names, and upstream ships an adapter only for Claude Code. In Codex, read
this file once per session instead of `docs/harness/claude-code.md`, then map each Cursor name in a
skill with the tables below. `<pstack>` is the newest version folder under
`~/.codex/plugins/cache/cursor-plugins/pstack/`. If a Cursor field has no row, drop it and say so.

## Tools

| Cursor                                                 | Codex                                                                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Task`                                                 | `spawn_agent`, then `wait_agent` for its result.                                                                                                            |
| `AskQuestion`                                          | `request_user_input`. In `codex exec` it is absent, so ask in plain text.                                                                                   |
| Open a todolist                                        | Use `update_plan` if the session offers it. Otherwise keep the list in your reply and update it at each phase.                                              |
| Run another pstack skill (`/name` or "the `name` skill") | Read `<pstack>/skills/<name>/SKILL.md` and follow it. When you tell the user to run it, write `$pstack:<name>`.                                             |
| `Grep`, `Glob`                                         | `rg` and `rg --files` through the shell.                                                                                                                    |

## Subagent fields

Codex has no agent types. Every subagent is a `spawn_agent` call, and its `message` carries the
role.

| Cursor                            | Codex                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_type: generalPurpose`   | `spawn_agent` with no role preamble.                                                                                                          |
| `poteto-agent`                    | Start the `message` with "Read `<pstack>/skills/poteto-mode/SKILL.md` in full before any work, including its Principles index", then the brief. |
| `comment-sicko`                   | Start the `message` with the body of `<pstack>/agents/comment-sicko.md`, then the brief. It is read-only.                                     |
| A fresh delegate                  | `fork_turns: "none"` and a self-contained brief. Pass `"all"` only when the delegate needs this chat's history.                               |
| `readonly: true`                  | The brief says "do not edit files", and you check `git status` afterward.                                                                     |
| `environment: "cloud"`            | A worktree under `.claude/worktrees/`. Name the branch or commit the worker checks out.                                                       |
| `environment: "local"`            | Omit.                                                                                                                                         |
| `run_in_background: true`         | Omit. Spawned agents run while you work; collect them with `wait_agent`.                                                                      |
| `resume`                          | `followup_task` or `send_message` to the same agent while it exists. Otherwise spawn a new agent and paste the earlier result into its brief. |
| `file_attachments`                | List the paths in the brief.                                                                                                                  |

## Models

Read `.agents/pstack/codex-models.md` at the start of every pstack task. Codex does not load it on
its own. If the file or the role's line is missing, map the skill's default slug with this table.

| Cursor or role value                         | Codex                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `<model> <effort>`, such as `gpt-6.1-sol high` | `spawn_agent` with `model: "<model>"` and `reasoning_effort: "<effort>"`.                       |
| `claude <model> <effort>`                    | Run the Claude CLI as described in `.agents/pstack/cross-tool.md`.                               |
| `claude-opus-*` and other Claude slugs       | `claude opus <effort>` through the Claude CLI, with the effort from the slug.                   |
| `grok-*` and other non-GPT slugs             | Omit `model` so the agent runs on the session model, and say so.                                |
| `auto` or `inherit-parent`                   | Omit `model` and `reasoning_effort`.                                                            |

## setup-pstack

Follow the skill with these changes. Detect models with `codex debug models`, keeping entries whose
`visibility` is `list`. Write `.agents/pstack/codex-models.md`, not a Cursor rule: no frontmatter,
then the comment lines, the `# budget` line, and one line per role. Keep every `claude` entry on a
rerun. Then offer to make the same change in `.claude/rules/pstack-models.md`, so both tools stay in
agreement.

## Paths

| Cursor                                                  | Codex                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `.cursor/skills/`, `~/.cursor/skills/`                  | `.agents/skills/`, `~/.agents/skills/`                                                                                                      |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json`      | `~/.codex/plugins/cache/`, `.claude-plugin/plugin.json`                                                                                     |
| `.cursor/rules/*.mdc`, always-applied rules             | `AGENTS.md`. Codex never reads `.mdc` files. The model rule is the exception. See Models.                                                    |
| `https://github.com/cursor/plugins/blob/main/pstack/<path>` | `<pstack>/<path>` when that file exists. Read the local copy and never fetch it. Give the user the URL when they need a link.            |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`. The first line's `cwd` names the workspace. Read only this workspace's sessions. |

## Cursor-only features

Codex has no Cursor Automations, Bugbot, Cursor cloud agents, or built-in PR tool. When a step
needs one, put one line in your reply, `Skipped in Codex: <step>. <reason>.`, then go on to the
next step. Do not stop, ask, or retry. Bugbot comments on a GitHub PR are ordinary review threads,
and a step that opens a PR uses `gh pr create`, which needs no skip line.
