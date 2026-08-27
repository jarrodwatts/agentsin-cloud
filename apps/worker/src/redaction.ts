const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|mnemonic|passphrase|password|private.?key|profile|secret|signing|token|wallet)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const EVM_PRIVATE_KEY = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;

export const isForbiddenBootstrapKey = (key: string): boolean =>
  /(?:mnemonic|private.?key|seed|signing|wallet)/i.test(key);

export const containsForbiddenBootstrapMaterial = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsForbiddenBootstrapMaterial);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => isForbiddenBootstrapKey(key) || containsForbiddenBootstrapMaterial(child),
  );
};

const redactString = (value: string): string =>
  value.replace(BEARER_VALUE, "[REDACTED]").replace(EVM_PRIVATE_KEY, "[REDACTED]");

const redactValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(child, seen),
    ]),
  );
};

export const redactLogFields = (
  fields: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (SENSITIVE_KEY.test(key)) return [key, "[REDACTED]"];
      return [key, redactValue(value, new WeakSet())];
    }),
  );
