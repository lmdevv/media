import { createFileRoute } from "@tanstack/react-router";
import { Brand } from "effect";

import { LibraryScreen } from "@/components/admin/library";
import type { LibraryId } from "@/components/admin/types";

// The core checks the id on every call, and answers a malformed or unknown one as a missing library.
const libraryId = Brand.nominal<LibraryId>();

function Library() {
  const params = Route.useParams();

  return <LibraryScreen key={params.libraryId} libraryId={libraryId(params.libraryId)} />;
}

export const Route = createFileRoute("/admin/libraries_/$libraryId")({
  head: () => ({ meta: [{ title: "Library · [media]" }] }),
  component: Library,
});
