import { stdout } from "node:process";

import { writeWhooshBangCheckResult } from "../lib/whooshbang-preflight.mjs";

const resultPath = await writeWhooshBangCheckResult();
stdout.write(`contract_result=${resultPath}\n`);
