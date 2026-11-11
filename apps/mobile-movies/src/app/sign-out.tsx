import { ConfirmSheet } from "@/components/settings/confirm-sheet";
import { useSignOut } from "@/session/viewer";

export default function SignOut() {
  const signOut = useSignOut();

  return (
    <ConfirmSheet
      title="Sign out of [movies]?"
      description="This iPhone will need to sign in again."
      action="Sign Out"
      onConfirm={signOut}
      closesItself
    />
  );
}
