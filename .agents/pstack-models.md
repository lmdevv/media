# [media] pstack model configuration

Project-local adaptation of pstack's per-role configuration. This file replaces
`~/.cursor/rules/pstack-models.mdc` and `~/.claude/rules/pstack-models.md` for pstack skills used in
this repository. Re-run `/pstack:setup-pstack` to change it; do not write the user-global rule.

One line per role. Delete a line to fall back to the skill default.

- `<model> <effort>` with `opus`, `sonnet`, `haiku`, or `fable`: a native `Agent` subagent with
  `model` and `effort` set to those values.
- `codex:<model> <effort>`: a T3 `delegate_task` child task with `providerInstanceId: "codex"`,
  that `model`, and the `reasoningEffort` option set to `<effort>`.
- `inherit-parent` or `auto`: the role runs on the parent chat model (omit `model`). Alias entries
  in a panel list still count toward its fan-out.

The effort is always the last token, so poteto-mode's per-job raise and lower steps apply to it.
If a configured target is rejected, run the seat on the other entry's family and say so.

# budget: medium (high)
feature, refactoring: opus high
bug-fix: opus high
perf-issue: opus high
hillclimb: opus high
judgment and prose: opus high
hardest tasks: opus high
how explorer: codex:gpt-6.1-sol high
how explainer: opus high
why investigators: codex:gpt-6.1-sol high
why synthesizer: opus high
reflect tooling: codex:gpt-6.1-sol high
reflect judgment, divergent, synthesizer: opus high
arena runners: opus high, codex:gpt-6.1-sol high
arena cross-judge pool: opus high, codex:gpt-6.1-sol high
swarm workers: codex:gpt-6.1-sol high
architect runners: opus high, codex:gpt-6.1-sol high
interrogate reviewers: opus high, codex:gpt-6.1-sol high
