import { sha256 } from "@agent-relay/protocol";

import { normalizeWhooshBangBaseUrl } from "./bootstrap.js";

export function whooshbangMachineStreamKey(
  baseUrl: string | URL,
  machineClientId: string,
): string {
  if (
    machineClientId.length === 0 ||
    machineClientId.length > 128 ||
    [...machineClientId].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw new TypeError(
      "WhooshBang machine client ID must be a bounded opaque value.",
    );
  }
  return sha256(
    `${normalizeWhooshBangBaseUrl(baseUrl).origin}\u001f${machineClientId}`,
  );
}
