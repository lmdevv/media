# @music/media

The media service is the only process that touches music files. It scans library folders into
Convex through the job queue, watches them for changes, and serves signed audio streams and
artwork under `/media`. It never decides access: Convex signs URLs, the service only verifies them.

## Run

```sh
scripts/dev-backend.sh            # writes apps/media/.env.local for the local Convex backend
pnpm --filter @music/media dev    # rebuilds on change and restarts with .env.local
pnpm --filter @music/media build  # single bundle: apps/media/dist/main.js
node apps/media/dist/main.js      # production: configuration comes from the environment
```

`ffmpeg` and `ffprobe` must be on `PATH` (or set `FFMPEG_PATH` / `FFPROBE_PATH`). The bundle
includes every dependency, `music-metadata` too; `dist/` needs nothing else at runtime.

## Configuration

| Variable               | Default   | Meaning                                          |
| ---------------------- | --------- | ------------------------------------------------ |
| `CONVEX_URL`           | required  | Convex deployment URL                            |
| `MEDIA_SERVICE_SECRET` | required  | Shared secret for the `media:*` Convex functions |
| `STREAM_SIGNING_KEY`   | required  | HMAC key Convex signs stream and art URLs with   |
| `MEDIA_DATA_DIR`       | required  | Holds `art/<sha256>` and the transcode `cache/`  |
| `PORT`                 | `4100`    | HTTP port                                        |
| `MEDIA_CACHE_MAX_MB`   | `2048`    | Transcode cache size before LRU eviction         |
| `MEDIA_RESCAN_MINUTES` | `60`      | Periodic rescan, for file systems without events |
| `FFMPEG_PATH`          | `ffmpeg`  | ffmpeg binary                                    |
| `FFPROBE_PATH`         | `ffprobe` | ffprobe binary                                   |

## HTTP

- `GET /media/health`: `{ ok, convex, ffmpeg, version }`, 503 when not `ok`.
- `GET|HEAD /media/stream/:trackId?p=<original|aac-320|aac-128>&exp=&sig=`: `original` plays the
  file bytes; the AAC profiles transcode once into the cache (at most two ffmpeg runs at a time,
  concurrent requests share one run) and fall back to the original when ffmpeg fails on a
  browser-playable file. Single byte ranges, `ETag`, `If-None-Match`, and `If-Range` work on both.
- `GET|HEAD /media/art/:hash?exp=&sig=`: content-addressed artwork, cached as immutable.

Bad or expired signatures get 403. Logs are JSON on stdout and never include query strings.

## Jobs and watching

The worker subscribes to `media:pendingJobs`, claims one job at a time, renews its lease every five
seconds, stops when Convex reports the job cancelled, and finishes with a summary. Scans skip files
whose size and modification time Convex already has, read tags with `music-metadata`, store art by
SHA-256, upsert in batches of 100, and mark vanished files missing. Each library gets a recursive
`fs.watch` (debounced five seconds) and a periodic rescan; both call `media:requestScan`, which
returns the existing pending or running job instead of adding another. The first periodic rescan
runs at startup.

## Effect-free platform modules

Effect 4.0.2 marks `FileSystem`, `ChildProcess`, and `NodeRuntime` unstable, and the lint policy
rejects unstable Effect APIs as well as `node:fs` and `node:child_process` in Effect modules. File,
process, and watch calls therefore live in `src/platform/`, which does not import Effect;
`files.ts`, `ffmpeg.ts`, and `library-watcher.ts` translate their failures into typed errors.

## Tests

```sh
pnpm --filter @music/media test                          # unit and integration, needs ffmpeg
node apps/media/scripts/generate-fixtures.ts /tmp/lib    # the synthetic fixture library
```

The Convex end-to-end test runs when `MEDIA_E2E_CONVEX_URL`, `MEDIA_E2E_SERVICE_SECRET`, and
`MEDIA_E2E_SIGNING_KEY` are set (for example from `apps/media/.env.local`). It signs in as
`MEDIA_E2E_EMAIL` / `MEDIA_E2E_PASSWORD`, signing up first on a fresh deployment.
