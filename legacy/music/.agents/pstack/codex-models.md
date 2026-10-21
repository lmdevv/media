# pstack model configuration for Codex. One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit `spawn_agent` `model` and `reasoning_effort`). Alias entries in a panel list still count toward its fan-out.
# A real entry `<model> <effort>` maps to `spawn_agent` `model: "<model>"` and `reasoning_effort: "<effort>"`.
# A `claude <model> <effort>` entry runs Claude through the Claude Code CLI, not `spawn_agent`. Read `.agents/pstack/cross-tool.md` before you run one.
# Claude Code's matching roles live in `.claude/rules/pstack-models.md`. Change both files together.
# budget: medium (high)
feature, refactoring: inherit-parent
bug-fix: inherit-parent
perf-issue: inherit-parent
hillclimb: inherit-parent
judgment and prose: gpt-6.1-sol high
hardest tasks: gpt-6.1-sol high
how explorer: inherit-parent
how explainer: gpt-6.1-sol high
why investigators: inherit-parent
why synthesizer: gpt-6.1-sol high
reflect tooling: inherit-parent
reflect judgment, divergent, synthesizer: gpt-6.1-sol high
arena runners: gpt-6.1-sol high, claude opus high
arena cross-judge pool: gpt-6.1-sol high, claude opus high
swarm workers: inherit-parent
architect runners: gpt-6.1-sol high, claude opus high
interrogate reviewers: gpt-6.1-sol high, claude opus high
