import Ajv2020 from "ajv/dist/2020.js";

export function compileContractLockSchema(schema) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: true,
  });
  return ajv.compile(schema);
}
