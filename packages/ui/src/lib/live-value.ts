import { useSyncExternalStore } from "react";

/**
 * A value that moves on its own, such as a playing video's position: read it when it is needed,
 * as in an event handler, or follow it with {@link useLiveValue}. `get` answers the same value
 * until a change reaches `subscribe`'s listeners.
 */
export interface LiveValue<A> {
  readonly get: () => A;
  /** Calls `onChange` after each change; the returned function stops it. */
  readonly subscribe: (onChange: () => void) => () => void;
}

const subscribeNothing = (): (() => void) => () => undefined;

/** A live value that never moves. */
export const fixedValue = <A>(value: A): LiveValue<A> => ({
  get: () => value,
  subscribe: subscribeNothing,
});

/**
 * `select` of `live`'s value, re-rendering the caller only when that selection changes
 * (`Object.is`): a component that shows the chapter re-renders when the chapter changes, not at
 * every move of the position within it.
 */
export const useLiveValue = <A, B>(live: LiveValue<A>, select: (value: A) => B): B => {
  const read = (): B => select(live.get());

  return useSyncExternalStore(live.subscribe, read, read);
};
