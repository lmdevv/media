# Lar pstack model configuration

This repository's copy of the user-wide pstack rule, `~/.claude/rules/pstack-models.md`. In this
repository a role's line here wins over that file, and a role missing here falls back to it. Re-run
`/pstack:setup-pstack` to change both.

One line per role. Delete a line to fall back to the user-wide file.

- `<model> <effort>` with `opus`, `sonnet`, `haiku`, or `fable`: a native `Agent` subagent with
  `model` and `effort` set to those values.
- `codex:<model> <effort>`: a T3 `delegate_task` child task with `providerInstanceId: "codex"`,
  that `model`, and the `reasoningEffort` option set to `<effort>`.
- `inherit-parent` or `auto`: the role runs on the parent chat model (omit `model`). Alias entries
  in a panel list still count toward its fan-out.

The effort is always the last token, so poteto-mode's per-job raise and lower steps apply to it.
If a configured target is rejected, run the seat on another entry's family and say so.

# defaults: 3
# budget: large (xhigh)
feature, refactoring: opus xhigh
bug-fix: opus xhigh
perf-issue: opus xhigh
hillclimb: opus xhigh
judgment and prose: opus xhigh
arena runners: fable high, opus high, codex:gpt-6.2-sol high
arena cross-judge pool: opus high, codex:gpt-6.2-sol high
swarm workers: codex:gpt-6.2-sol high
interrogate reviewers: fable high, opus xhigh, codex:gpt-6.2-sol xhigh
