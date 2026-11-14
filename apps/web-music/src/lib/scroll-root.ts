/**
 * The element a list scrolls in: the app's `main` column, or the viewport outside the shell.
 * Intersection observers need it as their root, because a `rootMargin` only grows the root: with
 * the viewport as root, rows clipped by `main`'s overflow would never count as near.
 */
export const scrollRootOf = (node: Element): Element | null => node.closest("main");
