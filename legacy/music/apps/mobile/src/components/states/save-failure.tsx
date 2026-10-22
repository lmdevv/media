/**
 * G13 · A save that failed without losing anything: the screen keeps what it showed (an optimistic
 * change rolls back to what the server kept), and a sheet says so with Try again, which sends the
 * same save again, and Cancel. Forms don't need it: they keep their fields and show the server's
 * reason under them, and their own button is the retry. This is for one-tap saves, which have no
 * form to hold a message.
 */
import { router } from "expo-router";
import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

/** A failed save, as the G13 sheet shows and retries it. */
export interface SaveFailure {
  /** What stayed as it was, such as `This song’s like is unchanged.` */
  readonly unchanged: string;
  /** Sends the same save again; a rejection keeps the sheet open with the reason. */
  readonly retry: () => Promise<void>;
}

interface SaveFailures {
  readonly failure: SaveFailure | null;
  readonly setFailure: (failure: SaveFailure | null) => void;
}

const SaveFailureContext = createContext<SaveFailures | null>(null);

/** Holds the failed save the G13 sheet shows, for the signed-in app. */
export function SaveFailureProvider({ children }: { readonly children: ReactNode }) {
  const [failure, setFailure] = useState<SaveFailure | null>(null);

  return <SaveFailureContext value={{ failure, setFailure }}>{children}</SaveFailureContext>;
}

const useSaveFailures = (): SaveFailures => {
  const failures = useContext(SaveFailureContext);

  if (failures === null) throw new Error("G13 needs SaveFailureProvider above it");

  return failures;
};

/**
 * Runs a one-tap save; if the server refuses it, G13 offers to send it again. Resolves either way,
 * so callers can settle their pending state in `finally`.
 *
 * @throws When used outside `SaveFailureProvider`, a programming error.
 */
export const useSave = (): ((save: () => Promise<void>, unchanged: string) => Promise<void>) => {
  const { setFailure } = useSaveFailures();

  return async (save, unchanged) => {
    try {
      await save();
    } catch {
      setFailure({ unchanged, retry: save });
      router.push("/save-failed");
    }
  };
};

/** The failed save on show in G13, and the way to let it go. */
export interface FailedSave {
  readonly failure: SaveFailure | null;
  readonly dismiss: () => void;
}

/**
 * The failed save on show in G13.
 *
 * @throws When used outside `SaveFailureProvider`, a programming error.
 */
export const useFailedSave = (): FailedSave => {
  const { failure, setFailure } = useSaveFailures();

  return { failure, dismiss: () => setFailure(null) };
};
