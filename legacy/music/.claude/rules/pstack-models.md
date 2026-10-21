# pstack model configuration for Claude Code. One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit Agent `model`). Alias entries in a panel list still count toward its fan-out.
# A `codex <model> <effort>` entry runs GPT through the Codex CLI, not the Agent tool. Read `.agents/pstack/cross-tool.md` before you run one.
# This file is project-scoped and committed. Edit it by hand: `/pstack:setup-pstack` writes `~/.claude/rules/` and cannot detect `codex` entries.
# Codex's matching roles live in `.agents/pstack/codex-models.md`. Change both files together.
# budget: medium (high)
feature, refactoring: inherit-parent
bug-fix: inherit-parent
perf-issue: inherit-parent
hillclimb: inherit-parent
judgment and prose: opus high
hardest tasks: opus high
how explorer: inherit-parent
how explainer: opus high
why investigators: inherit-parent
why synthesizer: opus high
reflect tooling: inherit-parent
reflect judgment, divergent, synthesizer: opus high
arena runners: opus high, codex gpt-6.1-sol high
arena cross-judge pool: opus high, codex gpt-6.1-sol high
swarm workers: inherit-parent
architect runners: opus high, codex gpt-6.1-sol high
interrogate reviewers: opus high, codex gpt-6.1-sol high
