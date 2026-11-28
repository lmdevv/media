import { ConfirmSheet } from "@/components/settings/confirm-sheet";
import { useSignOut } from "@/session/viewer";

export default function SignOut() {
  const signOut = useSignOut();

  return (
    <ConfirmSheet
      title="Sign out of Lar Movies?"
      description="This iPhone will need to sign in again, and your downloads will be removed from it."
      action="Sign Out"
      onConfirm={signOut}
      closesItself
    />
  );
}
