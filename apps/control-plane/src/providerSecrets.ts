const SENSITIVE_FIELD =
  /(?:assertion|authorization|cookie|credential|dek|email|mnemonic|passkey|passphrase|password|private.?key|profile.?payload|recovery.?(?:bundle|email)|secret|signing|stamp|token|wallet|wrapped.?key)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PRIVATE_KEY_VALUE = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;

const secretBrand: unique symbol = Symbol("agents-in-cloud/provider-secret");

/** A value that cannot be serialized or interpolated accidentally. */
export class Secret<Value> {
  readonly [secretBrand] = true;
  readonly #value: Value;

  private constructor(value: Value) {
    this.#value = value;
  }

  static make<Value>(value: Value): Secret<Value> {
    return new Secret(value);
  }

  withValue<Result>(use: (value: Value) => Result): Result {
    return use(this.#value);
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }
}

export type Redacted<Value> = {
  readonly value: "[REDACTED]";
  readonly [secretBrand]?: Value;
};

export const redacted = <Value>(): Redacted<Value> => ({ value: "[REDACTED]" });

const redactString = (value: string) =>
  value
    .replace(BEARER_VALUE, "[REDACTED]")
    .replace(JWT_VALUE, "[REDACTED]")
    .replace(PRIVATE_KEY_VALUE, "[REDACTED]");

const redactValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value instanceof Secret) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_FIELD.test(key) ? "[REDACTED]" : redactValue(child, seen),
    ]),
  );
};

/** Produces diagnostic fields that cannot contain common credential forms. */
export const redactProviderLogFields = (
  fields: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      SENSITIVE_FIELD.test(key) ? "[REDACTED]" : redactValue(value, new WeakSet()),
    ]),
  );
