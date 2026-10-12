import type { ContainerPort } from "../../forkhorse-runner/src/types";

/** Explicit mocked container port: no process or container is started. */
export class MockContainer implements ContainerPort {
  running = false;
  starts = 0;
  images = { default: `registry.idiot.tax/fixture@sha256:${"a".repeat(64)}` };
  commands: string[][] = [];
  commit = "";
  constructor(public exitStatus = 0) {}
  start() { this.starts++; this.running = true; }
  async destroy() { this.running = false; }
  async setInactivityTimeout() {}
  async interceptOutboundHttps() {}
  async exec(argv: string[]): Promise<ExecProcess> {
    this.commands.push(argv);
    if (argv[1] === "fetch") this.commit = argv.at(-1)!;
    const isCheck = argv[0] === "timeout";
    const stdout = argv[1] === "rev-parse" ? `${this.commit}\n` : isCheck ? "fixture output\n" : "";
    return {
      stdout: new Response(stdout).body, stderr: new Response("").body,
      stdin: null, pid: 1, isPty: false,
      exitCode: Promise.resolve(isCheck ? this.exitStatus : 0),
      kill() {}, resize() {},
      output: async () => ({ stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0), exitCode: 0 }),
    };
  }
}
