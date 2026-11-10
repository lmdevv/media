import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Paged } from "@media/ui/lib/pages";

/** A callback a view test never fires. */
export const noop = (): void => undefined;

/** A view's text as a person reads it: the markup without tags, entities decoded, spaces folded. */
export const textOf = (node: ReactElement): string =>
  renderToStaticMarkup(node)
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/gu, " ");

/** Whether the view draws the button labeled `label` disabled. */
export const disabledButton = (node: ReactElement, label: string): boolean =>
  new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`, "u").test(
    renderToStaticMarkup(node),
  );

/** A loaded list, with more pages after it or not. */
export const loaded = <Row>(rows: ReadonlyArray<Row>, more = false): Paged<Row> => ({
  status: "ready",
  rows,
  next: more ? { kind: "more", load: noop } : { kind: "done" },
});
