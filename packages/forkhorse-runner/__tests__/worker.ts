import { ReceiptRunner as NativeReceiptRunner } from "../src/index";
export { QuickFiles } from "../src/snapshot";
export class ReceiptRunner extends NativeReceiptRunner {
  fixturePorts() { return this.quickPorts(); }
}
export default { fetch() { return new Response("offline fixture"); } };
