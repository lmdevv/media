# End-to-end tests

Playwright tests that drive the web app against a real Convex backend.

```sh
WEB_PORT=3002 scripts/dev-backend.sh web 3510   # a backend, and apps/web/.env.local
pnpm --filter web exec playwright install chromium
pnpm test:e2e                                    # from the repo root
```

- The backend comes from `E2E_CONVEX_URL`, or `VITE_CONVEX_URL` in `apps/web/.env.local`.
- The app runs on `E2E_PORT` (default 3002); a dev server already on that port is reused.
- No media service runs here, so `packages/backend/scripts/seed.ts` stands in for its scanner:
  the tests run it to create the admin and library and to finish scan jobs. It reads the
  deployment from `packages/backend/.env.local`, so that file must point at the same backend.
  `e2e/media-stand-in.ts` stands in for its HTTP API on the port the backend expects (`PORT` in
  `apps/media/.env.local`): it answers the health check and plays a tone for every song. Stop a
  media service from `pnpm dev` first; Playwright refuses to start while that port is taken. The
  real media service is covered by the stack suite in `apps/web/e2e-stack`.
- `01-setup.spec.ts` covers first-run setup and only runs on an empty backend. To run it, reset:
  `scripts/dev-backend.sh stop web && docker volume rm music-convex-web-data`, then start the
  backend again. The other tests work on either a fresh or an existing backend.
- `CHROMIUM_PATH` points Playwright at a system Chromium (on NixOS: `$(which chromium)`).
- CI runs this suite on a fresh backend through `scripts/backend-e2e.sh web`, along with the
  Vitest suites that need a live backend.
