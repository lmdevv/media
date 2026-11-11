import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { TitleGridPage } from "@/components/browse/title-grid-page";

const Genre = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(100));

const decodeGenre = Schema.decodeSync(Genre);

export const Route = createFileRoute("/_app/genre/$genre")({
  params: {
    parse: (raw) => ({ genre: decodeGenre(raw.genre) }),
    stringify: (params) => ({ genre: params.genre }),
  },
  head: ({ params }) => ({ meta: [{ title: `${params.genre} · [movies]` }] }),
  component: GenrePage,
});

function GenrePage() {
  const { genre } = Route.useParams();

  return <TitleGridPage key={genre} genre={genre} heading={genre} />;
}
