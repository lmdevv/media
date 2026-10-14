# Convex functions

The [music] backend: every piece of product state, auth, live sync, and the job queue the media
service works from. Clients never call these files by name; they go through the command registry.

| File                                | Role                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `schema.ts`                         | Tables and indexes                                                                     |
| `commands.ts`                       | `read`/`run`: every registry command from `@music/commands`, checked both ways         |
| `handlers/`                         | One handler per registry command, grouped by area                                      |
| `auth.ts`, `users.ts`, `apiKeys.ts` | Convex Auth: passwords, invites, and API keys for the CLI                              |
| `media.ts`                          | The media service's functions, gated by `MEDIA_SERVICE_SECRET`; never access decisions |
| `migrations.ts`                     | Data migrations, resumable; run after every deploy                                     |
| `maintenance.ts`, `crons.ts`        | Scheduled clean-up                                                                     |
| `lib/`                              | Shared helpers: the viewer and its libraries, signing, catalog text                    |

Convex never calls the media service: the service subscribes to the `jobs` table here and
reports back through `media.ts`.

## Deploying

- **Development:** `scripts/dev-backend.sh` starts a self-hosted backend in Docker, deploys these
  functions, runs `migrations:run`, and sets the environment (`scripts/configure.ts`).
  `pnpm dev` keeps it deployed as files change.
- **Container:** `/app/bin/init` does the same on every start, after exporting a backup when the
  deployed build changed (see [`docs/operations.md`](../../../docs/operations.md)).

A schema change must keep rows written by earlier versions valid: make new fields optional, or
add a migration to `migrations.ts`. Commit the regenerated `_generated/` folder.
