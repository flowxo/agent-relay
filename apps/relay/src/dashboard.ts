import { execFile } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";

import { WebMetaV1Schema } from "./web-contract.js";
import { readWebCredential } from "./web-credential.js";
import { assertLocalMcpDaemonUrl } from "./mcp-server.js";
import { WebBootstrapGrantResponseSchema } from "./web-session.js";

export interface DashboardLaunchResult {
  schema: "agent-relay-dashboard-launch.v1";
  opened: true;
  url: string;
  networking: "loopback-only";
}

export class DashboardLaunchError extends Error {
  public override readonly name = "DashboardLaunchError";

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type DashboardBrowserOpener = (url: string) => Promise<void>;

export interface DashboardLaunchOptions {
  daemonUrl: string;
  stateDirectory: string;
  daemonToken?: string;
  fetch?: typeof fetch;
  openBrowser?: DashboardBrowserOpener;
  timeoutMs?: number;
  webCredentialPath?: string;
}

interface SafeFetchResult {
  response: Response;
  body: unknown;
}

async function requestJson(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  unavailableCode: string,
  unavailableMessage: string,
): Promise<SafeFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new DashboardLaunchError(unavailableCode, unavailableMessage);
  } finally {
    clearTimeout(timer);
  }
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    throw new DashboardLaunchError(
      "dashboard-readiness-invalid",
      "The local daemon returned an invalid dashboard readiness response. Restart or reinstall Agent Relay, then retry.",
    );
  }
  return { response, body };
}

function persistentHeaders(
  origin: string,
  credential: { token: string; csrfToken: string },
  mutation: boolean,
): Record<string, string> {
  return {
    authorization: `Bearer ${credential.token}`,
    origin,
    ...(mutation
      ? {
          "content-type": "application/json",
          "x-agent-relay-csrf": credential.csrfToken,
        }
      : {}),
  };
}

export const openDefaultBrowser: DashboardBrowserOpener = async (url) => {
  const operatingSystem = platform();
  const [command, args] =
    operatingSystem === "darwin"
      ? ["/usr/bin/open", [url]]
      : operatingSystem === "linux"
        ? ["xdg-open", [url]]
        : operatingSystem === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : [undefined, []];
  if (command === undefined) {
    throw new Error("unsupported browser launcher");
  }
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: 5_000, windowsHide: true }, (error) =>
      error === null ? resolve() : reject(error),
    );
  });
};

async function revokeGrant(
  fetchImplementation: typeof fetch,
  origin: string,
  credential: { token: string; csrfToken: string },
  grant: string,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImplementation(`${origin}/v1/web/bootstrap/revoke`, {
      method: "POST",
      headers: persistentHeaders(origin, credential, true),
      body: JSON.stringify({
        schema: "agent-relay-web-bootstrap-revoke.v1",
        grant,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    // The grant remains bounded by its short TTL when best-effort revocation fails.
  } finally {
    clearTimeout(timer);
  }
}

export async function launchWebDashboard(
  options: DashboardLaunchOptions,
): Promise<DashboardLaunchResult> {
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  let origin: string;
  try {
    origin = assertLocalMcpDaemonUrl(options.daemonUrl);
  } catch {
    throw new DashboardLaunchError(
      "dashboard-loopback-required",
      "The dashboard launcher accepts only an exact loopback HTTP daemon URL. Public listeners and tunnels are unsupported.",
    );
  }
  const status = await requestJson(
    fetchImplementation,
    `${origin}/v1/status`,
    {
      headers:
        options.daemonToken === undefined
          ? {}
          : { authorization: `Bearer ${options.daemonToken}` },
    },
    timeoutMs,
    "dashboard-daemon-unavailable",
    "The local Agent Relay daemon is unavailable. Start it with agent-relay daemon, then rerun agent-relay dashboard --web.",
  );
  if (!status.response.ok) {
    throw new DashboardLaunchError(
      "dashboard-daemon-rejected",
      status.response.status === 401
        ? "The local daemon rejected its private authorization. Restore AGENT_RELAY_DAEMON_TOKEN for this shell, then retry."
        : "The local daemon is not ready. Restart it, then rerun agent-relay dashboard --web.",
    );
  }
  const statusRecord =
    typeof status.body === "object" && status.body !== null
      ? (status.body as Record<string, unknown>)
      : {};
  if (statusRecord["healthy"] !== true) {
    throw new DashboardLaunchError(
      "dashboard-daemon-unhealthy",
      "The local daemon did not report healthy. Restart it, then rerun agent-relay dashboard --web.",
    );
  }
  if (statusRecord["webEnabled"] !== true) {
    throw new DashboardLaunchError(
      "dashboard-web-disabled",
      "The local web companion is disabled. Restart the daemon without --no-web and with AGENT_RELAY_WEB_ENABLED=1, then retry.",
    );
  }

  let credential;
  try {
    credential = await readWebCredential(
      options.webCredentialPath ??
        join(options.stateDirectory, "web-credential.json"),
    );
  } catch {
    throw new DashboardLaunchError(
      "dashboard-credential-unavailable",
      "The private local web credential is unavailable or unsafe. Restart the daemon with the intended state directory, repair the mode-0600 credential file, then retry.",
    );
  }

  const meta = await requestJson(
    fetchImplementation,
    `${origin}/v1/web/meta`,
    { headers: persistentHeaders(origin, credential, false) },
    timeoutMs,
    "dashboard-app-unavailable",
    "The protected local dashboard did not become ready. Restart the daemon or reinstall Agent Relay, then retry.",
  );
  if (!meta.response.ok || !WebMetaV1Schema.safeParse(meta.body).success) {
    throw new DashboardLaunchError(
      "dashboard-app-not-ready",
      meta.response.status === 401
        ? "The protected dashboard rejected the private local credential. Restart the daemon with the intended state directory, then retry."
        : "The protected dashboard assets and API are not compatible or ready. Restart or reinstall Agent Relay, then retry.",
    );
  }
  let asset: Response;
  const assetController = new AbortController();
  const assetTimer = setTimeout(() => assetController.abort(), timeoutMs);
  try {
    asset = await fetchImplementation(`${origin}/ui/app.js`, {
      method: "HEAD",
      cache: "no-store",
      signal: assetController.signal,
    });
  } catch {
    throw new DashboardLaunchError(
      "dashboard-app-unavailable",
      "The protected local dashboard assets are unavailable. Restart or reinstall Agent Relay, then retry.",
    );
  } finally {
    clearTimeout(assetTimer);
  }
  if (
    !asset.ok ||
    !asset.headers.get("content-type")?.includes("text/javascript")
  ) {
    throw new DashboardLaunchError(
      "dashboard-app-not-ready",
      "The protected local dashboard assets are not ready. Restart or reinstall Agent Relay, then retry.",
    );
  }

  const created = await requestJson(
    fetchImplementation,
    `${origin}/v1/web/bootstrap-grants`,
    {
      method: "POST",
      headers: persistentHeaders(origin, credential, true),
      body: JSON.stringify({
        schema: "agent-relay-web-bootstrap-create.v1",
      }),
    },
    timeoutMs,
    "dashboard-bootstrap-unavailable",
    "The protected dashboard could not create a local browser session. Retry agent-relay dashboard --web.",
  );
  const grantResult = WebBootstrapGrantResponseSchema.safeParse(created.body);
  if (!created.response.ok || !grantResult.success) {
    throw new DashboardLaunchError(
      "dashboard-bootstrap-rejected",
      "The protected dashboard could not create a local browser session. Retry agent-relay dashboard --web.",
    );
  }
  const bootstrapUrl = new URL("/ui/", origin);
  bootstrapUrl.searchParams.set("grant", grantResult.data.grant);
  try {
    await (options.openBrowser ?? openDefaultBrowser)(bootstrapUrl.toString());
  } catch {
    await revokeGrant(
      fetchImplementation,
      origin,
      credential,
      grantResult.data.grant,
      timeoutMs,
    );
    throw new DashboardLaunchError(
      "dashboard-browser-open-failed",
      "The default browser could not be opened. Check the desktop browser association, then rerun agent-relay dashboard --web.",
    );
  }
  return {
    schema: "agent-relay-dashboard-launch.v1",
    opened: true,
    url: `${origin}/ui/`,
    networking: "loopback-only",
  };
}
