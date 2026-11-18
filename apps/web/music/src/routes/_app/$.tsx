import { createFileRoute } from "@tanstack/react-router";

import { LazyPageNotFound } from "@/components/lazy-route-error";

/**
 * Any other path, for a signed-in user: the not-found screen inside the shell, player intact. It
 * shares the error screens' lazy chunk, with the same plain fallback when that chunk can't load.
 */
export const Route = createFileRoute("/_app/$")({ component: LazyPageNotFound });
