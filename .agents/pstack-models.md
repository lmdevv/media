# Lar pstack model roles

This repository's override of the user-wide list in `~/.claude/rules/pstack-models.md`, which
Claude Code and Codex share. In this repository a role's line here wins over that file, and a role
missing here falls back to it. Entries use the same notation, and the user-wide file's comment
lines say how each tool runs them.

# budget: medium (high)
feature, refactoring: opus high
bug-fix: opus high
perf-issue: opus high
hillclimb: opus high
judgment and prose: opus high
hardest tasks: opus high
how explorer: gpt-6.1-sol high
how explainer: opus high
why investigators: gpt-6.1-sol high
why synthesizer: opus high
reflect tooling: gpt-6.1-sol high
reflect judgment, divergent, synthesizer: opus high
arena runners: opus high, gpt-6.1-sol high
arena cross-judge pool: opus high, gpt-6.1-sol high
swarm workers: gpt-6.1-sol high
architect runners: opus high, gpt-6.1-sol high
interrogate reviewers: opus high, gpt-6.1-sol high
