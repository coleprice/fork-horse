import { createRoot } from "react-dom/client";
import { Select, TooltipProvider } from "@cloudflare/kumo";
export interface ForkOption {
  url: string;
  repoName: string;
  head: string;
}
/** The host retains selection authority; this component renders only the authorized list. */
export function mountForkPicker(root: HTMLElement, change: (url: string) => void) {
  const react = createRoot(root);
  return {
    render(forks: ForkOption[], value: string | undefined, message: string, loading = false) {
      react.render(
        <TooltipProvider>
          <div className="fork-picker">
            <Select
              label="Agent fork"
              size="sm"
              placeholder="Choose a fork"
              value={value ?? null}
              disabled={loading || !forks.length}
              loading={loading}
              items={forks.map((fork) => ({
                value: fork.url,
                label: `${fork.repoName} · ${fork.head.slice(0, 7)}`,
              }))}
              onValueChange={(url) => {
                if (url) change(url);
              }}
            />
            <p className="caption muted" role="status">
              {message}
            </p>
          </div>
        </TooltipProvider>,
      );
    },
    dispose() {
      react.unmount();
    },
  };
}
