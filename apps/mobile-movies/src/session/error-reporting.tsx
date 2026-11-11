import Constants from "expo-constants";
import { ErrorBoundary, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { Component } from "react";
import type { ReactNode } from "react";

import { useMediaServer } from "./media-server";

const appVersion = Constants.expoConfig?.version ?? "unknown";

interface BoundaryProps {
  readonly onError: (cause: unknown) => void;
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly error: Error | null;
}

class RenderErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(cause: unknown): BoundaryState {
    return { error: cause instanceof Error ? cause : new Error(String(cause), { cause }) };
  }

  override componentDidCatch(cause: unknown): void {
    void SplashScreen.hideAsync();
    this.props.onError(cause);
  }

  retry = (): Promise<void> =>
    new Promise((resolve) => {
      this.setState({ error: null }, resolve);
    });

  override render(): ReactNode {
    const { error } = this.state;

    if (error === null) return this.props.children;

    return <ErrorBoundary error={error} retry={this.retry} />;
  }
}

/**
 * Shows expo-router's error screen when `children` fails to render, and writes the failure to the
 * media service's retained log. Must sit below `SdkProvider`.
 */
export function ReportRenderErrors({ children }: { readonly children: ReactNode }) {
  const server = useMediaServer();
  const route = usePathname();

  return (
    <RenderErrorBoundary
      onError={(cause) =>
        void server.reportCaught(cause, { platform: "ios", appVersion, kind: "render", route })
      }
    >
      {children}
    </RenderErrorBoundary>
  );
}
