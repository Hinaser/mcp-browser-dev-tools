import assert from "node:assert/strict";
import test from "node:test";

import { statementBoundaries, wrapTopLevelAwait } from "./top-level-await.mjs";

// Runs code the way the page would: the wrapped form when there is one.
async function run(expression) {
  const wrapped = wrapTopLevelAwait(expression);
  return new Function(`return ${wrapped ?? expression}`)();
}

test("code that already runs as a script is left alone", () => {
  for (const expression of [
    "1 + 1",
    "document.title",
    "let x = 1; x + 1",
    "(async () => await 1)()",
  ]) {
    assert.equal(wrapTopLevelAwait(expression), null, expression);
  }
});

test("code without await or that does not compile is left alone", () => {
  assert.equal(wrapTopLevelAwait("return 5"), null);
  assert.equal(wrapTopLevelAwait("await ("), null);
  assert.equal(wrapTopLevelAwait("const = await 1"), null);
});

test("top-level await returns the value of the last expression", async () => {
  for (const [expression, expected] of [
    ["await Promise.resolve(6)", 6],
    ["(await Promise.resolve({ s: 2 })).s", 2],
    ["const r = await Promise.resolve({ s: 2 }); r.s", 2],
    ["const r = await Promise.resolve(3)\nr * 2", 6],
    ["const r = await Promise.resolve(3)\nr\n  .toFixed(1)", "3.0"],
    ["await Promise.resolve(1)\n  + 1", 2],
    ["const s = 'a;b\\n'; await 0; s", "a;b\n"],
    ["const t = `x${await Promise.resolve('y')}z`; t", "xyz"],
    ["const t = `;\n${`${await 0};`}`\nt", ";\n0;"],
    ["// a; comment\nawait Promise.resolve(1)", 1],
    ["/* a;\n b */ await Promise.resolve(1)", 1],
    ["const re = /[;/]\\//g; await 0; re.source", "[;/]\\/"],
    ["let n = 0\nfor (let i = 0; i < 3; i++) { n += await i }\nn", 3],
    ["const o = { a: [1, 2] }\nawait 0\no.a.length", 2],
    ["const v = await Promise.resolve(1)", undefined],
    ["await 0; const v = 1", undefined],
    ["await 0; 42;", 42],
    ["await 0; 42; // done", 42],
    ["await Promise.resolve(5);", 5],
    ["await 0; let a = 1; a\n++a", 2],
    ["await 0; let a = 1\n--a", 0],
    ["await 0\n/* comment */ 42", 42],
    ["await 0; if (true) {} 42", 42],
    ["await 0\nif (true) { 1 }\n'after'", "after"],
    ["const o = { a: 1 }\n+ await Promise.resolve(1)", undefined],
    ["await 0; let n = 0; for (let i = 0; i < 3; i++)\n++n\nn", 3],
    ["await 0; let n = 0; for (let i = 0; i < 3; i++)\n++n", undefined],
    ["let n = 0\nwhile (n < 3)\nn += await 1\nn", 3],
    ["if (await Promise.resolve(false))\n'no'\nelse\n'yes'", undefined],
  ]) {
    assert.deepEqual(await run(expression), expected, expression);
  }
});

test("a final block or declaration returns nothing rather than a new value", async () => {
  for (const expression of [
    "{a: await 1}",
    "await 0; {a: 1}",
    "await 0; function f() { return 1 }",
    "await 0; async function f() {}",
    "await 0; class A {}",
    "await 0; async /* comment */ function f() {}",
  ]) {
    assert.equal(await run(expression), undefined, expression);
  }
});

test("a final function declaration stays hoisted", async () => {
  assert.equal(
    await run(
      "await 0; globalThis.saved = typeof f; async /* comment */ function f() {}",
    ),
    undefined,
  );
  assert.equal(globalThis.saved, "function");
  delete globalThis.saved;
});

test("wrapped code keeps its declarations inside the call", async () => {
  assert.equal(await run("let x = await 1; x"), 1);
  assert.equal(await run("let x = await 2; x"), 2);
});

test("statementBoundaries skips strings, comments, templates, and brackets", () => {
  const source = "a('x;\\n');\nb = `;\n${c;}`; // d;\ne(/;/)\n{ f; }";
  // After the call's `;` and at its newline, after the template's `;`, at
  // the newline ending the comment, at the newline after e(/;/), and after
  // the block; none inside the string, template, regex, or block.
  const { boundaries, end } = statementBoundaries(source);
  const heads = boundaries.map((index) => source.slice(0, index).trimEnd());
  assert.equal(heads.length, 6);
  assert.equal(end, source.length);
  for (const [head, ending] of heads.map((head, i) => [
    head,
    ["');", "');", "`;", "// d;", "(/;/)", "{ f; }"][i],
  ])) {
    assert.ok(
      head.endsWith(ending),
      `${JSON.stringify(head)} ends with ${ending}`,
    );
  }
});
