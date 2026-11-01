import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAcpProviderInstallationRun, getAcpProviderInstallationStatus } from "./provider-maintenance.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(current: string, check: string | null) {
  const root = await mkdtemp(path.join(tmpdir(), "bb-omp-maintenance-"));
  roots.push(root);
  const command = path.join(root, "omp");
  await writeFile(command, `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log(${JSON.stringify(`omp ${current}`)}); } else { ${check === null ? "process.exit(1);" : `console.log(${JSON.stringify(check)});`} }\n`);
  await chmod(command, 0o755);
  return { command, dialectId: "omp", maintenance: undefined };
}

describe.skipIf(process.platform === "win32")("omp native installation maintenance", () => {
  it("offers the self-updater with target-version verification on the existing dialect", async () => {
    const target = await fixture("18.10.1", "Current version: 18.10.1\nNew version available: 18.10.2");
    expect(await getAcpProviderInstallationStatus(target)).toMatchObject({
      currentVersion: "18.10.1", latestVersion: "18.10.2", needsUpdate: true,
      installAction: { kind: "update", label: "Update" },
    });
    expect(await getAcpProviderInstallationRun({ ...target, action: "update" })).toEqual({
      available: true,
      command: { command: target.command, args: ["update"], displayCommand: "omp update" },
      verification: { kind: "version_at_least", version: "18.10.2" },
    });
    expect(await getAcpProviderInstallationRun({ ...target, action: "install" })).toMatchObject({ available: false });
  });

  it("does not offer an update when current, offline, or when the channel reports an older release", async () => {
    for (const check of [null, "Already up to date", "New version available: 18.9.1"]) {
      const target = await fixture("18.10.2", check);
      const status = await getAcpProviderInstallationStatus(target);
      expect(status.needsUpdate).toBe(false);
      expect(status.installAction).toBeNull();
      expect(status.latestVersion).toBe(check === null ? null : check.includes("Already") ? "18.10.2" : "18.9.1");
      expect(await getAcpProviderInstallationRun({ ...target, action: "update" })).toMatchObject({ available: false });
    }
  });

  it("keeps local-only checks offline and respects prerelease versions reported by omp", async () => {
    const target = await fixture("18.10.2", "New version available: 18.11.0-canary.2");
    expect(await getAcpProviderInstallationStatus({ ...target, checkUpdates: false })).toMatchObject({
      installed: true, currentVersion: "18.10.2", latestVersion: null, needsUpdate: false, installAction: null,
    });
    expect(await getAcpProviderInstallationStatus(target)).toMatchObject({ latestVersion: "18.11.0-canary.2", needsUpdate: true });
  });

  it("preserves calendar-version identifiers during local-only checks", async () => {
    const target = await fixture("2026.10.09-abcdef", null);
    expect(await getAcpProviderInstallationStatus({ ...target, checkUpdates: false })).toMatchObject({
      installed: true,
      currentVersion: "2026.10.09-abcdef",
      latestVersion: null,
      needsUpdate: false,
      installAction: null,
    });
  });
});
