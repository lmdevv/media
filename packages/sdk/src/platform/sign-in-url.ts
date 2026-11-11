import { SIGN_IN_PATH } from "@media/contracts/sign-in";

/** The sign-in boundary of the media server at `serverUrl`, such as `http://nas:8080`. */
export const signInUrlFor = (serverUrl: string): string =>
  `${serverUrl.replace(/\/+$/u, "")}${SIGN_IN_PATH}`;

/**
 * The sign-in boundary beside the platform at `platformUrl` in an install, which serves the
 * platform at `<server>/convex` and the media server at `<server>` (ADR 0027). A URL that does not
 * end in `/convex` is taken as the server's own.
 */
export const signInUrlBeside = (platformUrl: string): string =>
  signInUrlFor(serverUrlBeside(platformUrl));

/**
 * The media server beside the platform at `platformUrl` in an install: the address without its
 * `/convex` (ADR 0027). A URL that does not end in `/convex` is taken as the server's own.
 */
export const serverUrlBeside = (platformUrl: string): string =>
  platformUrl.replace(/\/+$/u, "").replace(/\/convex$/u, "");
