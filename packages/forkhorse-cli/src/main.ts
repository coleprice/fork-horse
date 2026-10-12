#!/usr/bin/env node
import process from "node:process";
import { runCli } from "./cli.ts";

const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    process.env,
    {
      out: (text) => {
        process.stdout.write(text);
      },
      err: (text) => {
        process.stderr.write(text);
      },
    },
    controller.signal,
  );
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
