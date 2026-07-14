export * from "./app";
export * from "./config";
export * from "./job-manager";
export * from "./project-store";
export * from "./security";

import { startSequencesServer } from "./main";

if (import.meta.main) await startSequencesServer();
