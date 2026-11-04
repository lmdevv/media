import { createContext, use } from "react";

/** The sidebar as pages see it. */
export interface SidebarControl {
  readonly placement: "beside" | "hidden";
  /** Shows it, or hides it again. */
  readonly toggle: () => void;
}

export const SidebarControlContext = createContext<SidebarControl | null>(null);

/** The sidebar this page shares the window with; null where there is none. */
export const useSidebarControl = (): SidebarControl | null => use(SidebarControlContext);
