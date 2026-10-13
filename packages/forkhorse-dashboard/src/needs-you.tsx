import { useState } from "react";
import { Badge, Button, LayerCard } from "@cloudflare/kumo";
import { ArrowLineUp, CaretRight, Check, GitBranch, Warning, XCircle } from "@phosphor-icons/react";
import type { Brand, ProjectState } from "./contracts.ts";
import { copyText, ownerNeeds, type CopyPart, type OwnerNeed } from "./needs-you-model.ts";

const icons = {
  promotionPending: Warning,
  reconciler: GitBranch,
  blocker: Warning,
  failed: XCircle,
  promote: ArrowLineUp,
  approve: Check,
};
function Copy({ parts }: { parts: CopyPart[] }) {
  return parts.map((part, index) =>
    typeof part === "string" ? (
      part
    ) : (
      <code key={index} title={part.full}>
        {part.code}
      </code>
    ),
  );
}
export function NeedsYou({
  state,
  brand,
  open,
}: {
  state: ProjectState;
  brand: Brand;
  open(target: OwnerNeed["target"]): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = ownerNeeds(state, brand);
  return (
    <section aria-labelledby="needs-you-title">
      <LayerCard className="p-4 needs-you-card">
        <div className="needs-you-heading">
          <h2 id="needs-you-title" className="heading-3">
            Needs you
          </h2>
          {items.length > 0 && <Badge variant="secondary">{items.length}</Badge>}
        </div>
        {items.length ? (
          <>
            <ul className="needs-you-list">
              {(expanded ? items : items.slice(0, 5)).map((item) => {
                const Icon = icons[item.kind];
                return (
                  <li key={item.id} data-need={item.kind}>
                    <button
                      type="button"
                      className="needs-you-row"
                      aria-label={`${copyText(item.title)}. ${copyText(item.outcome)}`}
                      onClick={() => open(item.target)}
                    >
                      <Icon size={16} aria-hidden="true" className="needs-you-icon" />
                      <span className="needs-you-copy">
                        <strong className="needs-you-title">
                          <Copy parts={item.title} />
                        </strong>
                        <span className="caption muted">
                          <Copy parts={item.why} />
                        </span>
                        <span className="caption">
                          <Copy parts={item.outcome} />
                        </span>
                      </span>
                      <span className="needs-you-open" aria-hidden="true">
                        Open <CaretRight size={16} aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {!expanded && items.length > 5 && (
              <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
                Show all {items.length}
              </Button>
            )}
          </>
        ) : (
          <p className="needs-you-empty muted">
            <Check size={16} aria-hidden="true" />
            Nothing needs you right now.
          </p>
        )}
      </LayerCard>
    </section>
  );
}
