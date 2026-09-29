export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(normalize)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [
                key,
                normalize((item as Record<string, unknown>)[key]),
              ]),
          )
        : item;
  return JSON.stringify(normalize(value));
}

export function validateSchema(
  schema: unknown,
  value: unknown,
  depth = 0,
): void {
  if (depth > 24 || !schema || typeof schema !== "object")
    throw new Error("Invalid schema or excessive nesting");
  const rule = schema as Record<string, unknown>;
  if (Array.isArray(rule.enum) && !rule.enum.includes(value))
    throw new Error("Value is outside the schema enum");
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    const matches = types.some((type) =>
      type === "null"
        ? value === null
        : type === "array"
          ? Array.isArray(value)
          : type === "object"
            ? value !== null &&
              typeof value === "object" &&
              !Array.isArray(value)
            : type === "integer"
              ? Number.isInteger(value)
              : typeof value === type,
    );
    if (!matches) throw new Error("Value has an invalid schema type");
  }
  if (
    typeof value === "number" &&
    typeof rule.minimum === "number" &&
    value < rule.minimum
  )
    throw new Error("Value is below the schema minimum");
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      (typeof rule.maximum === "number" && value > rule.maximum))
  )
    throw new Error("Value exceeds the schema maximum");
  if (
    typeof value === "string" &&
    (value.length > Number(rule.maxLength ?? 200000) ||
      value.length < Number(rule.minLength ?? 0) ||
      (typeof rule.pattern === "string" &&
        !new RegExp(rule.pattern).test(value)))
  )
    throw new Error("String violates schema bounds or pattern");
  if (Array.isArray(value)) {
    if (value.length > Number(rule.maxItems ?? 1000))
      throw new Error("Array exceeds schema limit");
    for (const item of value) validateSchema(rule.items, item, depth + 1);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const properties = (rule.properties ?? {}) as Record<string, unknown>;
    if (
      Array.isArray(rule.required) &&
      rule.required.some((key) => !Object.hasOwn(record, String(key)))
    )
      throw new Error("Required schema field is missing");
    for (const [key, item] of Object.entries(record)) {
      if (!Object.hasOwn(properties, key)) {
        if (rule.additionalProperties === false)
          throw new Error("Unknown schema field");
      } else validateSchema(properties[key], item, depth + 1);
    }
  }
}
