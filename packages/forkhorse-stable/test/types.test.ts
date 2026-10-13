import assert from "node:assert/strict";
import { test } from "node:test";
import { forkAddress, storedAgentKeyProvider } from "../src/index.ts";
import type { BearerAuthorization, CredentialCall, CredentialProvider, ForkAddressInput } from "../src/index.ts";

test("exported helper/provider shapes compose with an HTTP adapter", async () => {
  const call: CredentialCall = { origin: "https://mcp.idiot.tax", project: "demo" };
  const input: ForkAddressInput = { ...call, repoName: "demo--builder-1" };
  const provider: CredentialProvider = storedAgentKeyProvider(() => ({
    coreOrigin: call.origin, project: call.project, agentCredential: "fixture_agent_key_only",
  }));
  const authorization: BearerAuthorization = await provider.getBearer(call);
  const request = new Request(forkAddress(input), { headers: { authorization }, redirect: "manual" });
  assert.equal(request.headers.get("authorization"), authorization);
});

// These are compile-time assertions only; the function is never called.
function rejectedShapes(provider: CredentialProvider) {
  // @ts-expect-error The HTTP destination must name its project.
  void provider.getBearer({ origin: "https://mcp.idiot.tax" });
  // @ts-expect-error A fork address must name a repository.
  forkAddress({ origin: "https://mcp.idiot.tax", project: "demo" });
  // @ts-expect-error A provider has no raw credential property.
  void provider.agentCredential;
}
void rejectedShapes;
