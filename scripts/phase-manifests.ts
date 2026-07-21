export interface PhaseCheck {
  id: string;
  label: string;
  command: string[];
  timeoutMs: number;
}

export interface PhaseManifest {
  phase: number;
  title: string;
  checks: PhaseCheck[];
}

export const PHASE_MANIFESTS: ReadonlyMap<number, PhaseManifest> = new Map([
  [
    0,
    {
      phase: 0,
      title: "Reliable foundation",
      checks: [
        {
          id: "doctor",
          label: "Pinned environment",
          command: ["bun", "run", "doctor"],
          timeoutMs: 2 * 60_000,
        },
        {
          id: "typecheck",
          label: "TypeScript contracts",
          command: ["bun", "run", "typecheck"],
          timeoutMs: 2 * 60_000,
        },
        {
          id: "build",
          label: "Client production build",
          command: ["bun", "run", "build"],
          timeoutMs: 3 * 60_000,
        },
        {
          id: "unit-and-fixture-lifecycle",
          label: "Unit, security, replay, and verified automatic promotion",
          command: [
            "bun",
            "x",
            "vitest",
            "run",
            "--config",
            "vitest.config.ts",
            "--exclude",
            "apps/web/test/server/phase-one.test.ts",
          ],
          timeoutMs: 5 * 60_000,
        },
        {
          id: "browserless-project-smoke",
          label: "Browserless local product loop",
          command: ["bun", "run", "test:project"],
          timeoutMs: 3 * 60_000,
        },
        {
          id: "pinned-hyperframes-qa",
          label: "Pinned HyperFrames fixture QA",
          command: ["bun", "run", "qa:fixture"],
          timeoutMs: 10 * 60_000,
        },
        {
          id: "render-and-download",
          label: "Draft render, ffprobe, boundary frames, and downloads",
          command: ["bun", "scripts/phase-zero-delivery.ts"],
          timeoutMs: 30 * 60_000,
        },
      ],
    },
  ],
  [
    1,
    {
      phase: 1,
      title: "Deterministic fresh-build and SaaS result contract",
      checks: [
        {
          id: "typecheck",
          label: "Phase 1 semantic and director contracts",
          command: ["bun", "run", "typecheck"],
          timeoutMs: 2 * 60_000,
        },
        {
          id: "fresh-generation-result-contract",
          label: "Fixture-authored semantic artifacts and automatic promotion",
          command: [
            "bun",
            "x",
            "vitest",
            "run",
            "--config",
            "vitest.config.ts",
            "apps/web/test/server/phase-one.test.ts",
          ],
          timeoutMs: 5 * 60_000,
        },
        {
          id: "intent-aware-layout-repair",
          label: "Overlap intent, clustered inspection, bounded same-run repair, and rollback",
          command: [
            "bun",
            "x",
            "vitest",
            "run",
            "--config",
            "vitest.config.ts",
            "apps/web/test/server/layout-contracts.test.ts",
            "apps/web/test/server/layout-clusters.test.ts",
            "apps/web/test/server/layout-inspector.test.ts",
            "apps/web/test/server/layout-adjudication.test.ts",
            "apps/web/test/server/overlap-policy.test.ts",
            "apps/web/test/server/candidate-checkpoint.test.ts",
            "apps/web/test/server/qa-remediation.test.ts",
          ],
          timeoutMs: 5 * 60_000,
        },
        {
          id: "build",
          label: "Sequences watch-only Studio and timeline",
          command: ["bun", "run", "build"],
          timeoutMs: 3 * 60_000,
        },
      ],
    },
  ],
]);

export const COMPLETED_PHASES = [0, 1] as const;
