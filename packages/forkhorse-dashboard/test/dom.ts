import { createRequire } from "node:module";
/** DOM-only fixtures. ResizeObserver is a no-layout shim; browser acceptance checks real geometry. */
export function installDom(window: Window & typeof globalThis) {
  for (const name of [
    "window",
    "document",
    "HTMLElement",
    "Element",
    "Node",
    "MutationObserver",
    "getComputedStyle",
    "HTMLInputElement",
    "HTMLSelectElement",
    "DocumentFragment",
    "ShadowRoot",
    "HTMLButtonElement",
  ] as const)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === "window" ? window : window[name],
    });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
  // jsdom 26 has MouseEvent but no PointerEvent; Base UI synthesizes a click from keyboard input.
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: class extends window.MouseEvent {
      pointerId = 1;
      pointerType = "mouse";
      isPrimary = true;
    },
  });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (callback) =>
    setTimeout(() => callback(Date.now()), 16) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

// Base UI detects DOM availability when imported, before individual test windows exist.
const { JSDOM } = createRequire(import.meta.url)("jsdom");
installDom(new JSDOM("<body></body>").window);
