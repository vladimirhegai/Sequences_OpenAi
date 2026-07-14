import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "..");
const cliPath = join(workspaceRoot, "node_modules", "hyperframes", "dist", "cli.js");

if (!existsSync(cliPath)) {
  console.error("Hyperframes is not installed. Run `bun install` first.");
  process.exit(1);
}

const child = Bun.spawn(["node", cliPath, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DO_NOT_TRACK: "1",
    HYPERFRAMES_NO_AUTO_INSTALL: "1",
    HYPERFRAMES_NO_TELEMETRY: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    HYPERFRAMES_SKIP_SKILLS: "1",
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const forwardSignal = (signal: NodeJS.Signals): void => {
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited.
  }
};

process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

process.exit(await child.exited);
