import assert from "node:assert/strict";
import test from "node:test";

import { validateValue } from "./json-schema.mjs";

test("additionalProperties checks every own key, including inherited names", () => {
  const map = { type: "object", additionalProperties: { type: "string" } };
  validateValue("headers", { "X-Test": "1" }, map);
  assert.throws(
    () => validateValue("headers", { toString: 123 }, map),
    /headers\.toString must be a string/,
  );

  const closed = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  assert.throws(
    () => validateValue("args", { constructor: 1 }, closed),
    /args\.constructor is not allowed/,
  );
});

test("exclusiveMinimum rejects the bound itself", () => {
  const schema = { type: "number", exclusiveMinimum: 0 };
  validateValue("kbps", 0.5, schema);
  assert.throws(() => validateValue("kbps", 0, schema), /must be > 0/);
});
