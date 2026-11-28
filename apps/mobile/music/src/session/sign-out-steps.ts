/** What signing out this app does, each step a call that may fail. */
export interface SignOutSteps {
  /** Releases the person's downloads on the core, while their session still can. */
  readonly release: () => Promise<void>;
  /** Ends this app's session on the server and here. */
  readonly signOut: () => Promise<void>;
  /** Deletes the server's downloads on this phone. */
  readonly wipe: () => Promise<void>;
}

/**
 * Releases, signs out, then wipes. The wipe runs even when signing out rejects, since the core
 * holds none of the released songs any more, and the rejection still reaches the caller. A wipe
 * that fails leaves the files for the next sign-out.
 */
export const signOutInOrder = async ({ release, signOut, wipe }: SignOutSteps): Promise<void> => {
  await release();

  try {
    await signOut();
  } finally {
    await wipe().catch(() => undefined);
  }
};
