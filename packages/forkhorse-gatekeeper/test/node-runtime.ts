import { registerHooks } from "node:module";

// Root and frozen upstream install separately. One RPC session must use one Cap'n Web runtime
// identity, just as the Vite bundle does; equal versions in two installs are not the same class.
const capnweb = import.meta.resolve("capnweb");
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "capnweb" ? capnweb : specifier, context);
  },
});
