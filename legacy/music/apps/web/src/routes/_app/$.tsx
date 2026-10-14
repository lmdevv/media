import { createFileRoute } from "@tanstack/react-router";

import { PageNotFound } from "@/components/route-error";

/** Any other path, for a signed-in user: the not-found screen inside the shell, player intact. */
export const Route = createFileRoute("/_app/$")({ component: PageNotFound });
