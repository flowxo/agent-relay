import { stdout } from "node:process";

import { writeNotificationsCheckResult } from "../lib/notifications-preflight.mjs";

const resultPath = await writeNotificationsCheckResult();
stdout.write(`contract_result=${resultPath}\n`);
