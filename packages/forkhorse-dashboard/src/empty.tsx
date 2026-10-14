import { Empty } from "@cloudflare/kumo";

const firstRun = {
  projects: {
    title: "No projects configured.",
    description: "Set up a project, then open it here to follow its work.",
    next: "Set up a project",
  },
  agents: {
    title: "No enrolled agents.",
    description: "Enroll an agent so it can work in its own fork.",
    next: "Enroll an agent",
  },
  packets: {
    title: "No packets yet",
    description: "Create a packet with a goal, allowed paths and acceptance checks.",
    next: "Create a packet",
  },
  reviews: {
    title: "No reviews yet.",
    description: "After an agent pushes its work, it can request your review of that commit.",
    next: "Request a review",
  },
  races: {
    title: "No races yet.",
    description: "A race lets up to three agents work on the same packet in their own forks.",
    next: "Create a race packet",
  },
};

/** Read-only help. The caller supplies an existing docs location; this adds no API route. */
export function FirstRunEmpty({ kind, href }: { kind: keyof typeof firstRun; href: string }) {
  const hint = firstRun[kind];
  return (
    <div data-first-run={kind}>
      <Empty
        size="sm"
        title={hint.title}
        description={hint.description}
        contents={<a className="claim-link" href={href} target="_blank" rel="noreferrer">{hint.next}</a>}
      />
    </div>
  );
}
