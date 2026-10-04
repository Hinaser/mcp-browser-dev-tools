export function validateValue(path, value, schema) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }

    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const key of required) {
      if (value[key] === undefined) {
        throw new Error(`${path}.${key} is required`);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          throw new Error(`${path}.${key} is not allowed`);
        }
      }
    } else if (typeof schema.additionalProperties === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (!Object.hasOwn(properties, key)) {
          validateValue(`${path}.${key}`, item, schema.additionalProperties);
        }
      }
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (value[key] !== undefined) {
        validateValue(`${path}.${key}`, value[key], propertySchema);
      }
    }

    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`${path} must be an array`);
    }

    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${path} must have at least ${schema.minItems} items`);
    }

    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error(`${path} must have at most ${schema.maxItems} items`);
    }

    if (schema.items) {
      value.forEach((item, index) => {
        validateValue(`${path}[${index}]`, item, schema.items);
      });
    }

    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      throw new Error(`${path} must be a string`);
    }

    if (schema.enum && !schema.enum.includes(value)) {
      throw new Error(`${path} must be one of: ${schema.enum.join(", ")}`);
    }

    return;
  }

  if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`${path} must be a boolean`);
    }

    return;
  }

  if (schema.type === "integer") {
    if (!Number.isInteger(value)) {
      throw new Error(`${path} must be an integer`);
    }

    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`${path} must be >= ${schema.minimum}`);
    }

    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new Error(`${path} must be <= ${schema.maximum}`);
    }

    return;
  }

  if (schema.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new Error(`${path} must be a number`);
    }

    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`${path} must be >= ${schema.minimum}`);
    }

    if (
      schema.exclusiveMinimum !== undefined &&
      value <= schema.exclusiveMinimum
    ) {
      throw new Error(`${path} must be > ${schema.exclusiveMinimum}`);
    }
  }
}
