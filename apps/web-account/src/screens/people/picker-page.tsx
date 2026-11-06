import type { ReactNode } from "react";

import { AuthPage } from "@/components/auth-page";

/** A picker's page: the centered title over its tiles, as movies' "Who's watching?". */
export function PickerPage({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <AuthPage width="page" centered>
      <div className="flex flex-col gap-5 md:items-center md:gap-14">
        <h1 className="text-large-title/10 font-heavy tracking-snug text-text md:text-display/display md:font-bold md:tracking-display">
          {title}
        </h1>
        {children}
      </div>
    </AuthPage>
  );
}

/** The grid of tiles on a picker: two columns on phones, one centered row on wider screens. */
export const PICKER_GRID =
  "grid grid-cols-2 justify-items-center gap-5 md:flex md:flex-wrap md:items-start md:justify-center md:gap-8";
