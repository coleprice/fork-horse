import FORK from "../fork-types.txt";
import WORKFLOW from "../workflow-types.txt";
import RECORDS from "../stable-records.txt";
import CONTRACTS from "../stable-contracts.txt";

// Code Mode receives a self-contained module. These are the actual accepted
// Stable declarations, not a second manually maintained copy of its records.
const standalone = (source: string) => source.replace(/^import type[\s\S]*?;\n/gm, "");
export const TYPES = `import type { RpcTarget } from "cloudflare:workers";\n${[RECORDS, CONTRACTS, WORKFLOW, FORK].map(standalone).join("\n")}`;
