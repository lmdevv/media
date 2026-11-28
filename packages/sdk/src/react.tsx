/**
 * `@media/sdk/react`: the SDK in React. `PlatformProvider` opens the platform deployment's client:
 * `usePlatform()` gives every command as a Promise method and `usePlatformQuery` follows a query.
 * Queries return a state instead of throwing; commands return Promises that reject with the SDK's
 * tagged errors.
 */
import type { ReactNode } from "react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import type { AuthStatus } from "./auth";
import type { Params, PromiseQuery } from "./platform/command";
import { createPlatform } from "./platform/promise";
import type { PlatformSdk } from "./platform/promise";
import * as QueryWatch from "./query-watch";
import type { QueryState } from "./query-watch";
import type { SaveAnswers } from "./platform/saved-answers";
import type { SharedStore } from "./shared-store";
import type { KeyValueStore } from "./token-storage";

export type { QueryState } from "./query-watch";

export type { SaveAnswers, SavedAnswersFile } from "./platform/saved-answers";

/** The session's status, read by every `usePlatformStatus` from one subscription. */
interface StatusStore {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly read: () => AuthStatus;
}

interface OpenPlatform {
  readonly platform: PlatformSdk;
  readonly status: StatusStore;
}

const PlatformContext = createContext<OpenPlatform | null>(null);

const followStatus = (platform: PlatformSdk): StatusStore => {
  let status: AuthStatus = "loading";
  const listeners = new Set<() => void>();

  void platform.session.onStatus((next) => {
    status = next;

    for (const listener of listeners) listener();
  });

  return {
    subscribe: (onChange) => {
      listeners.add(onChange);

      return () => {
        listeners.delete(onChange);
      };
    },
    read: () => status,
  };
};

/** Props for `PlatformProvider`. */
export interface PlatformProviderProps {
  /** The platform deployment's URL. */
  readonly url: string;
  /** The media server's sign-in boundary, where every sign-in goes (ADR 0007). */
  readonly signInUrl: string;
  /**
   * Where the session lives: a `SharedStore` the origin's clients share, such as IndexedDB from
   * `openIndexedDb`, or a store this client owns. Pass the same object on every render: a new one
   * opens a new client and remounts the tree.
   */
  readonly storage: KeyValueStore | SharedStore;
  /**
   * The key the session is stored under; `media.session` when omitted, which every client on the
   * origin shares, so one sign-in serves them all (ADR 0020).
   */
  readonly storageKey?: string;
  /**
   * The queries whose answers the client saves for the next launch, and where (`SaveAnswers`);
   * nothing is saved when omitted. Pass the same object on every render: a new one opens a new
   * client.
   */
  readonly saved?: SaveAnswers | undefined;
  readonly children: ReactNode;
}

/**
 * Opens the platform client for the tree over its own WebSocket. The client is created and
 * disposed by one effect, so React's development double mount never leaves a disposed client in
 * use; children render once it exists.
 */
export const PlatformProvider = (props: PlatformProviderProps): ReactNode => {
  const { url, signInUrl, storage, storageKey, saved } = props;
  const [open, setOpen] = useState<OpenPlatform | null>(null);

  useEffect(() => {
    const platform = createPlatform({
      url,
      signInUrl,
      connection: "websocket",
      storage,
      storageKey,
      saved,
    });

    setOpen({ platform, status: followStatus(platform) });

    return () => {
      setOpen(null);
      void platform.dispose();
    };
  }, [url, signInUrl, storage, storageKey, saved]);

  if (open === null) return null;

  return <PlatformContext.Provider value={open}>{props.children}</PlatformContext.Provider>;
};

const openedOncePerClient = new WeakMap<PlatformSdk, OpenPlatform>();

const openOf = (platform: PlatformSdk): OpenPlatform => {
  const known = openedOncePerClient.get(platform);

  if (known !== undefined) return known;

  const open = { platform, status: followStatus(platform) };

  openedOncePerClient.set(platform, open);

  return open;
};

/** Props for `PlatformClientProvider`. */
export interface PlatformClientProviderProps {
  /** A client from `createPlatform` that the caller keeps open, and disposes if ever. */
  readonly platform: PlatformSdk;
  readonly children: ReactNode;
}

/**
 * Provides a platform client its caller opened, such as the one a web app's entry point opens for
 * the page's lifetime so its route loaders reach the same client as its screens.
 */
export const PlatformClientProvider = ({
  platform,
  children,
}: PlatformClientProviderProps): ReactNode => {
  const open = useMemo(() => openOf(platform), [platform]);

  return <PlatformContext.Provider value={open}>{children}</PlatformContext.Provider>;
};

/**
 * Every platform command as a Promise method, such as `usePlatform().core.server.info()`, and the
 * session. The same object for the provider's lifetime.
 *
 * @throws When used outside `PlatformProvider` or `PlatformClientProvider`, a programming error.
 */
export const usePlatform = (): PlatformSdk => useOpenPlatform().platform;

const useOpenPlatform = (): OpenPlatform => {
  const open = useContext(PlatformContext);

  if (open === null) throw new Error("usePlatform must be used inside PlatformProvider");

  return open;
};

// SAFETY: a type predicate, not checked by the compiler. An arguments object is never the string
// `"skip"`.
const isSkipped = <Args,>(params: Params<Args> | readonly ["skip"]): params is readonly ["skip"] =>
  params[0] === "skip";

/**
 * Follows a platform query, re-rendering on every change: `usePlatformQuery(platform.core.server.info)`.
 * Pass `"skip"` in place of the arguments to wait. Network failures and rate limiting retry with
 * backoff first; a failure carries `retry` for a Try again button.
 */
export const usePlatformQuery = <Args, Result>(
  method: PromiseQuery<Args, Result>,
  ...params: Params<Args> | readonly ["skip"]
): QueryState<Result> => {
  const key = isSkipped(params) ? null : JSON.stringify(params[0] ?? {});

  const watchFor = (): QueryWatch.QueryWatch<Result> =>
    isSkipped(params) ? QueryWatch.skipped : method.watch(...params);

  // State rather than a memo: React may drop a memo, which would restart a live subscription.
  const [held, setHeld] = useState(() => ({ method, key, watch: watchFor() }));
  let current = held;

  if (held.method !== method || held.key !== key) {
    current = { method, key, watch: watchFor() };
    setHeld(current);
  }

  const { watch } = current;

  return useSyncExternalStore(watch.subscribe, watch.getSnapshot, watch.getSnapshot);
};

/**
 * The platform session's status: `loading` until the stored session has been read. Every caller
 * reads one subscription the provider holds, so a component that mounts later sees the status at
 * once.
 */
export const usePlatformStatus = (): AuthStatus => {
  const { status } = useOpenPlatform();

  return useSyncExternalStore(status.subscribe, status.read, status.read);
};
