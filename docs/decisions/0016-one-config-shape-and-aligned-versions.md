# 0016. Use one config shape and align dependency versions

- Status: Accepted, 2026-11-03
- Decisions: D32, D33

## Context

Movies reads settings such as `MOVIES_BIND`, `MEDIA_BASE_URL`, and `TRANSCODE_DIR`, publishes two
ports, and keeps state in several volumes. Music has its own names, such as `PUBLIC_URL`,
`MEDIA_DATA_DIR`, and `STREAM_SIGNING_KEY`, and both claim `/data`.
Versions also differ. Movies pins `effect` 4.0.3 and Expo 58.0.14. Music pins `effect` 4.0.2,
Convex `^1.45.0`, and Expo 58.0.17.

Movies releases one version for the image, the Nix packages, the npm CLI, and the CLI binaries.
`scripts/check-version.sh` fails while any workspace package carries another version. The iOS app's
store version is exempt.

## Decision

- **Config.** One environment prefix (`MEDIA_`, ADR 0001), one public URL, one port, and one data
  root with a folder per domain.
- **Versions.** Effect 4.0.3, Convex 1.46, and Expo 58.0.17 across the repo.
- **Releases.** The server, the SDK, and the CLI release under one version. Each client has its own
  version.
- Movies' version check (`scripts/check-version.sh`) stays.

## Consequences

- Every setting is renamed once, in phase 2, and `scripts/check-deploy.sh` keeps naming any
  setting missing from the Compose files, `nix/module.nix`, or the READMEs.
- A domain's state lives under its own folder in the data root, so the domains' paths no longer
  clash.
- Music moves to Effect 4.0.3 and Convex 1.46. Movies moves to Expo 58.0.17.
- Both products already use some `MEDIA_` names with their own meanings, such as movies'
  `MEDIA_BASE_URL` and `MEDIA_SERVICE_API_KEY` and music's `MEDIA_DATA_DIR` and
  `MEDIA_SERVICE_SECRET`. Old music under `legacy/music/` keeps its own settings until it is
  deleted, so a renamed setting must not take a name that old music reads with another meaning.
- The version check covers the server, the SDK, and the CLI. Clients keep versions of their own,
  as movies' iOS app does today.

## Alternatives rejected

- One version for everything, clients included. Each client releases on its own.
- Separate settings per product. One prefix and one public URL cover the whole install.

## Edge cases settled

- The data root has one folder per domain, such as one for movies and one for music.
- A client's version does not have to match the server's.
