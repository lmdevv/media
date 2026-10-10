# [music]

Self-hosted music for people and agents. Stream your own library from one install, with
multi-user accounts, live handoff between devices, lossless and gapless playback, and a CLI that
can do everything the app can.

Early development. Nothing to install yet.

## Stack

- Convex for product state, auth, and live sync
- A Node + Hono + Effect media service for scanning, streaming, and transcoding with ffmpeg
- A Vite + React + TanStack Router web app
- An Effect CLI with an agent skill
- One container with Caddy and s6, or a NixOS module

## Development

```sh
nix develop
pnpm install
pnpm dev
```

See `AGENTS.md` for the layout, rules, and checks.

## License

MIT. The bundled Convex backend is FSL-1.1, converting to Apache-2.0 after two years.
