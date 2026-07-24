import { spawnSync } from "node:child_process";

import { HARNESS_CAPABILITIES } from "@agent-relay/harnesses";
import {
  FakeTelegramTransport,
  RelayService,
  RelayStore,
} from "@agent-relay/core";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  healthy: boolean;
  checks: DoctorCheck[];
}

function versionCheck(name: string, executable: string): DoctorCheck {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    shell: false,
  });
  if (result.error !== undefined || result.status !== 0) {
    return {
      name,
      ok: false,
      detail:
        result.error?.message ??
        result.stderr.trim() ??
        `exited with status ${String(result.status)}`,
    };
  }
  return {
    name,
    ok: true,
    detail: result.stdout.trim().split("\n")[0] ?? "version detected",
  };
}

export function runDoctor(databasePath = ":memory:"): DoctorReport {
  const checks: DoctorCheck[] = [];
  try {
    const store = new RelayStore(databasePath);
    const service = new RelayService(store, new FakeTelegramTransport());
    service.recover();
    const status = store.status();
    checks.push({
      name: "sqlite-spool",
      ok: status.pendingDeliveryCount === 0,
      detail: "SQLite schema opened and durable delivery state is readable",
    });
    store.close();
  } catch (error) {
    checks.push({
      name: "sqlite-spool",
      ok: false,
      detail:
        error instanceof Error ? error.message : "SQLite spool check failed",
    });
  }

  checks.push(versionCheck("codex", "codex"));
  checks.push(versionCheck("claude", "claude"));
  checks.push(versionCheck("cursor", "cursor-agent"));
  checks.push({
    name: "capability-matrix",
    ok: new Set(HARNESS_CAPABILITIES.map((entry) => entry.harness)).size === 3,
    detail: `${HARNESS_CAPABILITIES.length} harness/surface capability records loaded`,
  });
  return {
    healthy: checks.every((check) => check.ok),
    checks,
  };
}
