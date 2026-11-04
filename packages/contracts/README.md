# @media/contracts

Effect Schema contracts shared by the backend, media service, SDK, and CLI. Convex does not import
this package; `packages/backend/test/registry.test.ts` keeps its validators equal to these schemas.

| Entry point                       | What it holds                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@media/contracts/commands`       | The command registry: every user action with scope, args, result, function                         |
| `@media/contracts/command`        | Command definition types and helpers                                                               |
| `@media/contracts/media-service`  | The Convex functions the media service calls, with their schemas                                   |
| `@media/contracts/models/*`       | DTOs: `account`, `profiles`, `catalog`, `playback`, `rooms`, `jobs`, `scan`, `migration`, `common` |
| `@media/contracts/ids`            | Branded Convex document IDs and the client `DeviceId`                                              |
| `@media/contracts/units`          | `Milliseconds`, `EpochMillis`, `Bytes`                                                             |
| `@media/contracts/scopes`         | Roles, scopes, and how grants and roles combine                                                    |
| `@media/contracts/errors`         | Failure codes, the wire `CommandFailure`, and one tagged error per code                            |
| `@media/contracts/media-api`      | The media service's Effect HttpApi (playback negotiation, stream control, health)                  |
| `@media/contracts/media-playback` | Its routes, request and response schemas, and tagged errors, for clients without Effect HTTP       |
| `@media/contracts/artwork`        | Artwork keys and `artworkUrl` for images titles, seasons, and episodes carry                       |
| `@media/contracts/playback-token` | Playback token verifier and signer, and the shared test vectors                                    |
| `@media/contracts/clock`          | Room clock math, drift classification, and clock offset estimation                                 |
| `@media/contracts/content-rating` | Certification to minimum age, and the profile rating rule                                          |

Plugin role interfaces are added by the plugin milestone. `media-api` is the only module that uses an
unstable Effect module (`effect/http-api`); import `media-playback` where that is not allowed.
