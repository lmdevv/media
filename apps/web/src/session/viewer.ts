import type { Viewer } from "@media/contracts/models/account";
import type { Scope } from "@media/contracts/scopes";
import { useAuth, useCommandQuery } from "@media/sdk/react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { toastFailure } from "@/lib/failure";

import { useProfileChoice } from "./profile-choice";

/** The signed-in account and its session, or null while loading. Use inside signed-in screens. */
export const useViewer = (): Viewer | null => {
  const viewer = useCommandQuery("account.viewer", {});

  return viewer.status === "success" ? viewer.data : null;
};

/**
 * What this session may do. Empty while loading, so scope-gated actions appear once known rather
 * than flashing in and out.
 */
export const useScopes = (): ReadonlySet<Scope> => {
  const viewer = useViewer();

  return useMemo(() => new Set(viewer?.scopes ?? []), [viewer]);
};

/**
 * Signs out on the server and here, forgets this browser's profile choice, and returns to sign-in.
 */
export const useSignOut = (): (() => Promise<void>) => {
  const { signOut } = useAuth();
  const { choose } = useProfileChoice();
  const navigate = useNavigate();

  return useCallback(async () => {
    try {
      await signOut();
      choose(null);
      await navigate({ to: "/sign-in", replace: true });
    } catch (cause) {
      toastFailure(cause);
    }
  }, [signOut, choose, navigate]);
};
