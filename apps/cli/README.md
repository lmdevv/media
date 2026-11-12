# @lmdevv/media

The `media` command line for a self-hosted [media] server: everything the apps can do, for people
and agents, with JSON output by default. It replaces `@lmdevv/movies` and its `movies` command,
which cannot reach a [media] server.

```sh
npm install -g @lmdevv/media
media auth login --server http://nas.tailnet.ts.net:8080/convex --username <you>
media movies titles list --human
```

Each release ships the CLI with the same version as the server. Other installs (the release
binaries, Nix, Home Manager) and the agent skill in `skills/media/SKILL.md` are described in the
[README](https://github.com/lmdevv/media#cli).
