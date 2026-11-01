import type {
  ProviderInstallationRunResult,
  ProviderInstallationStatus,
} from "@bb/provider-bridge-protocol";
import {
  commandOutput,
  compareVersions,
  installationVerification,
  resolveExecutablePath,
  versionFrom,
} from "@bb/provider-bridge-protocol/bridge-kit";

const INSTALL_SCRIPT = "curl -fsSL https://omp.sh/install | sh -s -- --binary";

export async function getOmpInstallationStatus(args: {
  command: string | null;
  readVersion: (command: string) => Promise<string | null>;
  checkUpdates?: boolean;
}): Promise<ProviderInstallationStatus> {
  const executableName = args.command ?? "omp";
  const executablePath = await resolveExecutablePath(executableName);
  const installed = executablePath !== null;
  const currentVersion = installed ? await args.readVersion(executablePath) : null;
  let latestVersion: string | null = null;
  if (installed && args.checkUpdates !== false) {
    const output = await commandOutput(executablePath, ["update", "--check"]);
    const available = output?.match(/New version available:\s*(\S+)/u);
    latestVersion = available
      ? versionFrom(available[1] ?? null)
      : output?.includes("Already up to date")
        ? currentVersion
        : null;
  }
  const needsUpdate =
    currentVersion !== null &&
    latestVersion !== null &&
    compareVersions(latestVersion, currentVersion) > 0;
  const installAction = !installed
    ? process.platform === "win32"
      ? null
      : { kind: "install" as const, label: "Install" as const, command: INSTALL_SCRIPT }
    : needsUpdate
      ? { kind: "update" as const, label: "Update" as const, command: "omp update" }
      : null;
  return {
    executableName,
    executablePath,
    installed,
    installSource: installed ? "external" : "notInstalled",
    currentVersion,
    latestVersion,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction,
    needsUpdate,
    versionUnsupported: false,
  };
}

export async function getOmpInstallationRun(args: {
  command: string | null;
  readVersion: (command: string) => Promise<string | null>;
  action: "install" | "update";
}): Promise<ProviderInstallationRunResult> {
  const status = await getOmpInstallationStatus(args);
  if (status.installAction?.kind !== args.action) {
    return { available: false, message: `omp ${args.action} is no longer available on this host.` };
  }
  return {
    available: true,
    command: args.action === "install"
      ? { command: "sh", args: ["-c", INSTALL_SCRIPT], displayCommand: INSTALL_SCRIPT }
      : { command: status.executablePath ?? "omp", args: ["update"], displayCommand: "omp update" },
    verification: installationVerification(status, args.action),
  };
}
