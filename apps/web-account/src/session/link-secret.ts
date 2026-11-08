/** The pages whose links carry a secret after `#`: accepting an invite and a reset link. */
export type SecretPage = "/invite" | "/reset";

/** A link's secret, held in memory for the page it opened. */
export interface LinkSecret {
  readonly page: SecretPage;
  readonly secret: string;
}

const isSecretPage = (path: string): path is SecretPage => path === "/invite" || path === "/reset";

type Address = Pick<Location, "pathname" | "search" | "hash">;

/** Whether `address` is an invite or reset page whose link still shows its secret. */
export const showsLinkSecret = (address: Address): boolean =>
  isSecretPage(address.pathname) && address.hash.length > 1;

/**
 * Moves an invite or reset link's secret from the address into memory, and replaces the history
 * entry with the bare page. The secret travels after `#`, so no request or referrer carries it,
 * and once taken it is in neither the address bar nor history. Run before the router reads the
 * address. A reload finds no secret, so the link has to be opened again.
 */
export const takeLinkSecret = (
  address: Address,
  history: Pick<History, "state" | "replaceState">,
): LinkSecret | null => {
  const { pathname, search, hash } = address;

  if (!isSecretPage(pathname) || hash.length <= 1) return null;
  history.replaceState(history.state, "", `${pathname}${search}`);

  return { page: pathname, secret: hash.slice(1) };
};

/** The secret held for `page`, or an empty one that its lookup refuses. */
export const linkSecretFor = (held: LinkSecret | null, page: SecretPage): string =>
  held?.page === page ? held.secret : "";

/** The link to `page` that carries `secret`, as an admin hands it out. */
export const secretLink = (origin: string, page: SecretPage, secret: string): string =>
  `${origin}${page}#${secret}`;
