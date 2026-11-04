import { useAuth } from "@media/sdk/react";
import { useCallback } from "react";

import { useProfileChoice } from "./profile-choice";

/** Signs out on the server and here and forgets this device's profile choice. */
export const useSignOut = (): (() => Promise<void>) => {
  const { signOut } = useAuth();
  const { choose } = useProfileChoice();

  return useCallback(async () => {
    try {
      await signOut();
    } finally {
      await choose(null);
    }
  }, [signOut, choose]);
};
