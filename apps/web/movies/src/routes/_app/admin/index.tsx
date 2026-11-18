import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/")({
  beforeLoad: () => redirect({ to: "/admin/libraries", replace: true, throw: true }),
});
