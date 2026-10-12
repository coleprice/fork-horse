import { afterEach, describe, expect, it, vi } from "vitest";
import { errorResponse, HttpError, operation } from "../src/http";
import type { ErrorContext } from "../src/http";

const publicMessage = "Repository operation failed; retry or ask the owner to inspect it.";
const secret = "Bearer api_fixture_secret https://provider.idiot.tax/private?token=fixture";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
afterEach(() => vi.restoreAllMocks());

describe("secret-free error telemetry in workerd", () => {
  it("emits one allowlisted JSON line and returns its UUID without provider text", async () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error(secret), {
      name: "GitError", code: "UnexpectedError", status: 503,
      url: secret, headers: { authorization: secret }, response: secret, cause: secret,
      toJSON: () => { throw new Error("Provider serialization must never run"); },
    });
    const response = errorResponse(error, { op: "review.promote", stage: "prepare" });
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json<{ error: string; diagnosticId: string }>();
    expect(payload).toEqual({ error: publicMessage, diagnosticId: expect.stringMatching(uuid) });
    expect(log.mock.calls).toEqual([[JSON.stringify({
      event: "core.error", id: payload.diagnosticId, op: "review.promote", stage: "prepare",
      name: "GitError", code: "UnexpectedError", status: 503,
    })]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("api_fixture_secret");
    expect(JSON.stringify(payload)).not.toContain("provider.idiot.tax");
  });

  it.each(["", "Bearer api_fixture_secret", "https://provider.idiot.tax", "Error\n", "a".repeat(65), 500, { secret }])(
    "drops invalid name/code values without coercion: %j", async (value) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const response = errorResponse({ name: value, code: value, message: secret, status: "503" });
      const { diagnosticId } = await response.json<{ diagnosticId: string }>();
      expect(log.mock.calls).toEqual([[JSON.stringify({ event: "core.error", id: diagnosticId, op: "request" })]]);
    },
  );

  it("drops untrusted labels and non-HTTP status values; safely ignores throwing accessors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = {
      get name() { throw new Error(secret); },
      get code() { throw new Error(secret); },
      get status() { throw new Error(secret); },
      statusCode: Infinity,
      get message() { throw new Error("Message must never be read"); },
      get stack() { throw new Error("Stack must never be read"); },
    };
    const response = errorResponse(error, { op: secret, stage: secret } as unknown as ErrorContext);
    const { diagnosticId } = await response.json<{ diagnosticId: string }>();
    expect(log.mock.calls).toEqual([[JSON.stringify({ event: "core.error", id: diagnosticId, op: "request" })]]);
  });

  it("accepts bounded provider statusCode and produces a unique UUID for each failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await errorResponse({ name: "Artifacts.Error", code: "repo-not_found", statusCode: 404 }).json<{ diagnosticId: string }>();
    const second = await errorResponse({ name: "x".repeat(64), code: "A_0.-", status: 599.5 }).json<{ diagnosticId: string }>();
    expect(first.diagnosticId).toMatch(uuid);
    expect(second.diagnosticId).toMatch(uuid);
    expect(second.diagnosticId).not.toBe(first.diagnosticId);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ name: "Artifacts.Error", code: "repo-not_found", status: 404 });
    expect(JSON.parse(log.mock.calls[1]![0])).not.toHaveProperty("status");
  });

  it.each([409, 502])("leaves HttpError %s responses unchanged and emits no diagnostic", async (status) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = errorResponse(new HttpError(status, "Known public failure."), { op: "review.promote", stage: "push" });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Known public failure." });
    expect(log).not.toHaveBeenCalled();
  });

  it("labels operations without including caller-controlled path or query values", () => {
    const request = (path: string) => new Request(`https://api.idiot.tax${path}?token=api_fixture_secret`, { method: "POST" });
    expect(operation(request("/projects"))).toBe("project.create");
    expect(operation(request("/projects/private/forks/private/commit"))).toBe("fork.commit");
    expect(operation(request("/projects/private/reviews/private/promote"))).toBe("review.promote");
    expect(operation(request("/private"))).toBe("request");
  });
});
