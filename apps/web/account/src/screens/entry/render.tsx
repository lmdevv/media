import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** The markup of `node` inside a real router, so its links render as anchors. */
export const renderPage = (node: ReactNode): string =>
  renderToStaticMarkup(
    <RouterContextProvider
      router={createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() })}
    >
      {node}
    </RouterContextProvider>,
  );

/** Whether the button labelled `label` in `html` is disabled. */
export const isDisabled = (html: string, label: string): boolean => {
  const button = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gu)].find(
    ([, , inner]) => inner?.replaceAll(/<[^>]*>/gu, "").trim() === label,
  );

  if (button === undefined) throw new Error(`No button labelled ${label}`);

  return /\sdisabled=""/u.test(button[1] ?? "");
};
