# @media/contracts

Effect Schema contracts shared by the media service, the SDK, the CLI, and the clients. The core's
Convex functions stay plain TypeScript with `v` validators, declared in `packages/commands`
(ADR 0009). They import a few modules from here: `ticket`, `sign-in`, `library-folder`,
`direct-play`, and `artwork`.

| Entry point                         | What it holds                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `@media/contracts/ids`              | Branded Convex document IDs and the client `DeviceId`                                                                   |
| `@media/contracts/units`            | `Milliseconds`, `EpochMillis`, `Bytes`                                                                                  |
| `@media/contracts/scopes`           | The access levels a media command names, and the roles and scopes behind them                                           |
| `@media/contracts/errors`           | Failure codes, the wire `CommandFailure`, and one tagged error per code                                                 |
| `@media/contracts/content-rating`   | Certification to minimum age, and the rating rule                                                                       |
| `@media/contracts/clock`            | Shared clock math, drift classification, and clock offset estimation                                                    |
| `@media/contracts/ticket`           | The ticket format: signing, verifying, purposes, resources, and `artworkTicketId` (ADR 0011)                            |
| `@media/contracts/server-functions` | The core's functions only the media service calls, behind the `media-service` scope (ADR 0010)                          |
| `@media/contracts/ticket-vectors`   | Test keys and tickets that pin the ticket format's bytes                                                                |
| `@media/contracts/rate-limit`       | How often one client address may call what needs no session (ADR 0007)                                                  |
| `@media/contracts/sign-in`          | The sign-in boundary's path and the pass the core checks (ADR 0007)                                                     |
| `@media/contracts/command`          | Media command types: `MediaCommand`, `AnyCommand`, `CommandGroup`, `FunctionPath`, `WireSchema`                         |
| `@media/contracts/media-commands`   | The media service's own HTTP commands (`mediaCommands`), with their routes and schemas                                  |
| `@media/contracts/media-api`        | The media service's Effect HttpApi (playback negotiation, stream control, downloads, health)                            |
| `@media/contracts/media-playback`   | Its routes, request and response schemas, and tagged errors, for clients without Effect HTTP                            |
| `@media/contracts/artwork`          | Artwork keys, `ARTWORK_WIDTHS`, and artwork URLs                                                                        |
| `@media/contracts/trickplay`        | Scrub thumbnail manifests and their URLs                                                                                |
| `@media/contracts/cast`             | The client profile a Chromecast negotiates playback with                                                                |
| `@media/contracts/direct-play`      | Whether a client plays a file directly, shared by the media service, the SDK, and the clients                           |
| `@media/contracts/library-folder`   | The one way a library folder is written down                                                                            |
| `@media/contracts/scan-failure`     | The prefixes of a scan's folder failures, which the apps read back                                                      |
| `@media/contracts/migration-plan`   | Jellyfin and Plex import plans, as the importer and its screens read them                                               |
| `@media/contracts/diagnostics`      | Retained log records, log queries, player diagnostic events, and client error reports                                   |
| `@media/contracts/request-id`       | The media service's request id and the header that carries it                                                           |
| `@media/contracts/models/*`         | DTOs: `account`, `catalog`, `common`, `jobs`, `migration`, `migration-service`, `playback`, `profiles`, `rooms`, `scan` |

`media-api` is the only module that uses an unstable Effect module (`effect/http-api`); import
`media-playback` where that is not allowed.
