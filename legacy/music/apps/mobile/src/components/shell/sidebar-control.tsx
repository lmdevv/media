/**
 * What the pages in the tabs know of the iPad's sidebar: whether it sits beside them, in which
 * case they drop their own chrome (A1), or is hidden behind a button they draw (A3). There is no
 * sidebar on an iPhone, so its pages see null and keep theirs.
 */
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
