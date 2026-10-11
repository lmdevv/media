# End-to-end tests

Playwright tests that drive the web app against a real Convex backend.

```sh
WEB_PORT=3002 scripts/dev-backend.sh web 3510   # a backend, and apps/web/.env.local
pnpm --filter web exec playwright install chromium
pnpm test:e2e                                    # from the repo root
```

- The backend comes from `E2E_CONVEX_URL`, or `VITE_CONVEX_URL` in `apps/web/.env.local`.
- The app runs on `E2E_PORT` (default 3002); a dev server already on that port is reused.
- Until the media service lands, `packages/backend/scripts/seed.ts` stands in for it: the tests run
  it to create the admin and library and to finish scan jobs. It reads the deployment from
  `packages/backend/.env.local`, so that file must point at the same backend.
- `01-setup.spec.ts` covers first-run setup and only runs on an empty backend. To run it, reset:
  `scripts/dev-backend.sh stop web && docker volume rm music-convex-web-data`, then start the
  backend again. The other tests work on either a fresh or an existing backend.
