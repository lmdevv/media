import type { QueryState } from "@media/sdk/react";
import { useEffect } from "react";

import type { Me } from "./platform-types";
import { isRenewing } from "./screen";

const ASK_AGAIN_MS = 1000;

export const useIdentityRetry = (me: QueryState<Me>): void => {
  useEffect(() => {
    const timer =
      me.status === "error" && isRenewing(me.error)
        ? setTimeout(me.retry, ASK_AGAIN_MS)
        : undefined;

    return () => clearTimeout(timer);
  }, [me]);
};
