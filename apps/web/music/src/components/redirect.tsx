import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

/**
 * Replaces the current entry with `href` once. Router `<Navigate>` fires again whenever its parent
 * re-renders during the pending navigation, which loops when the parent is a guard layout.
 */
export function Redirect({ href }: { readonly href: string }) {
  const navigate = useNavigate();
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;

    sent.current = true;
    void navigate({ href, replace: true });
  }, [href, navigate]);

  return <div className="min-h-dvh bg-bg" />;
}
