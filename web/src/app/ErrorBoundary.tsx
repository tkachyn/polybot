import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../components/Button";
import { EmptyState } from "../components/Feedback";

type Props = {
  children: ReactNode;
  /** Changing this clears a caught error (e.g. the pathname). */
  resetKey?: unknown;
  /** Custom fallback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = { error: Error | null; key: unknown };

/** Keeps a crashing screen from blanking the shell. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ui] screen crashed", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div style={{ padding: "var(--space-6) var(--page-gutter)" }}>
        <EmptyState
          title="This screen hit an error."
          description={error.message || "Something went wrong while rendering."}
          action={
            <Button variant="ghost" onClick={this.reset}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
}
