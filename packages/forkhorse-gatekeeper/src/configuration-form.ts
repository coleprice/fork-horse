import type { ConnectionDraft, DraftStatus } from "./configuration.ts";
import { CONNECTION_HELD } from "./configuration.ts";

/** Fixture preparation only. The connection button cannot become enabled from format checks. */
export function mountConfiguration(root: HTMLElement, check: (draft: ConnectionDraft) => Promise<DraftStatus>) {
  root.innerHTML = `<h1>Prepare an agent connection</h1>
    <p>LOCAL FIXTURE ONLY · enter synthetic values. No credentials are verified or saved.</p>
    <form><label>Core origin<input name="coreOrigin" type="url" placeholder="https://core.fixture.idiot.tax" required></label>
      <label>Project ID<input name="project" required maxlength="48" autocomplete="off"></label>
      <label>Enrolled agent credential (fixture only)<input name="agentCredential" type="password" autocomplete="off" required maxlength="256"></label>
      <button type="button">Check format locally</button>
    </form><p role="status"></p><button data-create type="button" disabled>Create connection</button>`;
  const form = root.querySelector("form")!;
  const status = root.querySelector<HTMLElement>('[role="status"]')!;
  status.textContent = CONNECTION_HELD;
  const submit = form.querySelector("button")!;
  const field = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  let closed = false;
  const onSubmit = async (event: Event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const result = await check({ coreOrigin: field("coreOrigin").value,
        project: field("project").value, agentCredential: field("agentCredential").value });
      if (!closed) status.textContent = `Format checked for ${result.project}. ${CONNECTION_HELD}`;
    } catch {
      if (!closed) status.textContent = "Draft format check failed. Check the fields; no connection was created.";
    } finally {
      field("agentCredential").value = "";
      if (!closed) submit.disabled = false;
    }
  };
  form.addEventListener("submit", onSubmit);
  // The OS frame permits scripts, not form submissions. Use a local button event.
  submit.addEventListener("click", onSubmit);
  return { dispose() {
    closed = true;
    field("agentCredential").value = "";
    form.removeEventListener("submit", onSubmit);
    submit.removeEventListener("click", onSubmit);
  } };
}
