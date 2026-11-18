import { buttonVariants } from "@media/ui/lib/button-variants";
import { Link } from "@tanstack/react-router";

import { AuthPage, Lede, PageTitle } from "@/components/auth-page";
import type { Me } from "@/session/platform-types";

/** A page this session may not open: an account page on a shared-device tile, or admin for a member. */
export function NeedsAccountScreen({ me, admin }: { readonly me: Me; readonly admin: boolean }) {
  return (
    <AuthPage>
      <div className="flex flex-col gap-3">
        <PageTitle>{admin ? "Only admins can open this." : "Use your own device."}</PageTitle>
        <Lede>
          {admin
            ? `${me.username} isn't an admin on this server.`
            : `${me.username} is open as a tile on this shared device. Changing an account needs a sign-in on a device of your own.`}
        </Lede>
      </div>
      <Link to="/home" className={buttonVariants({ size: "lg", className: "w-full" })}>
        Go to Home
      </Link>
    </AuthPage>
  );
}
