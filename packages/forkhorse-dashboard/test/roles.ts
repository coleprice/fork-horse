import { createRequire } from "node:module";

// The frozen root toolchain already declares vite-plus -> @vitest/browser-preview ->
// @testing-library/dom (10.4.1 in pnpm-lock.yaml). Keep this DOM-only dependency
// here: no production import, extra install, machine path or imitation name algorithm.
const rootRequire = createRequire(new URL("../../../package.json", import.meta.url));
const toolchainRequire = createRequire(rootRequire.resolve("vite-plus"));
const previewRequire = createRequire(toolchainRequire.resolve("@vitest/browser-preview"));
const testingLibraryEntry = previewRequire.resolve("@testing-library/dom");
const testingLibraryRequire = createRequire(testingLibraryEntry);
export const { getByRole, queryByRole, getAllByRole } = testingLibraryRequire(testingLibraryEntry) as {
  getByRole(container: HTMLElement, role: string, options: { name: string | RegExp; hidden?: boolean }): HTMLElement;
  queryByRole(container: HTMLElement, role: string, options: { name: string | RegExp; hidden?: boolean }): HTMLElement | null;
  getAllByRole(container: HTMLElement, role: string, options: { name: string | RegExp; hidden?: boolean }): HTMLElement[];
};
export const { computeAccessibleName, computeAccessibleDescription } = testingLibraryRequire("dom-accessibility-api") as {
  computeAccessibleName(element: Element): string;
  computeAccessibleDescription(element: Element): string;
};
