import { useCallback } from "react";

import { useFirstRun } from "./first-run";

/** Ends owner setup and goes Home. It never fails. Outside setup it does nothing. */
export const useFinishSetup = (): (() => Promise<void>) => {
  const { end } = useFirstRun();

  return useCallback(async () => {
    end();
  }, [end]);
};
