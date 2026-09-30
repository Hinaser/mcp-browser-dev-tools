import vm from "node:vm";

// Firefox evaluates a classic script, where top-level await is a syntax error.
// Like a browser console, code that needs it runs inside an async function
// that returns the value of its last expression statement. Chromium's REPL
// mode handles this natively, so only the Firefox client uses it.

const AsyncFunction = (async () => {}).constructor;

function compiles(compile) {
  try {
    compile();
    return true;
  } catch {
    return false;
  }
}

const REGEX_AFTER_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "await",
  "yield",
]);

// Code starting with one of these continues what comes before it instead of
// starting a statement, so the newline or `}` before it is not a statement
// boundary. `++` and `--` do start a statement after a newline.
const CONTINUATION =
  /^(?:\+(?!\+)|-(?!-)|\/(?![/*])|[([`*%.,?:&|^<>=]|in\b|instanceof\b)/;

// A final statement starting like this is a block or a declaration in a
// script, not an expression, so it has no value to return.
const NOT_AN_EXPRESSION =
  /^(?:\{|function\b|class\b|async(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)+function\b)/;

const LEADING_COMMENTS = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/;

function stripLeadingComments(code) {
  return code.replace(LEADING_COMMENTS, "");
}

// Returns the offsets where a top-level statement may end (after a `;` or a
// block's `}`, or at a newline, outside strings, comments, templates, regex
// literals, and brackets), and the offset just past the last code that is
// not a `;`, so trailing semicolons and comments can be dropped.
export function statementBoundaries(source) {
  const boundaries = [];
  let end = 0;
  // Each entry is "{", "(", "[", or "${" for a template substitution.
  const stack = [];
  let lastSignificant = "";
  let lastWord = "";
  let index = 0;

  const regexAllowed = () =>
    lastSignificant === "" ||
    "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant) ||
    REGEX_AFTER_WORDS.has(lastWord);

  const skipTemplate = () => {
    // index is just past the opening backtick or a closing substitution.
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        index += 2;
      } else if (char === "`") {
        index += 1;
        return;
      } else if (char === "$" && source[index + 1] === "{") {
        stack.push("${");
        index += 2;
        return;
      } else {
        index += 1;
      }
    }
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "\n") {
      if (stack.length === 0) {
        boundaries.push(index);
      }
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      index += 1;
      while (index < source.length && source[index] !== char) {
        index += source[index] === "\\" ? 2 : 1;
      }
      index += 1;
      lastSignificant = char;
      lastWord = "";
      end = index;
      continue;
    }
    if (char === "`") {
      index += 1;
      skipTemplate();
      lastSignificant = "`";
      lastWord = "";
      end = index;
      continue;
    }
    if (char === "/" && regexAllowed()) {
      let inClass = false;
      index += 1;
      while (index < source.length && source[index] !== "\n") {
        const current = source[index];
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === "[") {
          inClass = true;
        } else if (current === "]") {
          inClass = false;
        } else if (current === "/" && !inClass) {
          break;
        }
        index += 1;
      }
      index += 1;
      while (index < source.length && /[a-z]/i.test(source[index])) {
        index += 1;
      }
      lastSignificant = "/";
      lastWord = "";
      end = index;
      continue;
    }
    if (/[A-Za-z_$0-9]/.test(char)) {
      const start = index;
      while (index < source.length && /[A-Za-z_$0-9]/.test(source[index])) {
        index += 1;
      }
      lastWord = source.slice(start, index);
      lastSignificant = "a";
      end = index;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
    } else if (char === ")" || char === "]") {
      stack.pop();
    } else if (char === "}") {
      if (stack.pop() === "${") {
        index += 1;
        skipTemplate();
        lastSignificant = "`";
        lastWord = "";
        end = index;
        continue;
      }
      if (stack.length === 0) {
        boundaries.push(index + 1);
      }
    } else if (char === ";") {
      if (stack.length === 0) {
        boundaries.push(index + 1);
      }
      lastSignificant = char;
      lastWord = "";
      index += 1;
      continue;
    }
    lastSignificant = char;
    lastWord = "";
    index += 1;
    end = index;
  }

  return { boundaries, end };
}

function asyncCall(body) {
  return `(async () => {\n${body}\n})()`;
}

// Returns the expression rewritten to run inside an async function, or null
// when it needs no rewrite: it already runs as a script, it does not use
// await (a stray top-level return stays an error, as on Chromium), or it
// does not compile even inside an async function.
export function wrapTopLevelAwait(expression) {
  if (compiles(() => new vm.Script(expression))) {
    return null;
  }
  if (!compiles(() => new AsyncFunction(expression))) {
    return null;
  }
  if (compiles(() => new Function(expression))) {
    return null;
  }

  const { boundaries, end } = statementBoundaries(expression);
  const code = expression.slice(0, end);
  const returning = (head, tail) => {
    // The code before the split must compile on its own, so the split falls
    // between top-level statements and never inside an unbraced loop body.
    if (
      NOT_AN_EXPRESSION.test(tail) ||
      (head && !compiles(() => new AsyncFunction(head)))
    ) {
      return null;
    }
    const body = `${head ? `${head}\n` : ""}return (\n${tail}\n);`;
    return compiles(() => new AsyncFunction(body)) ? asyncCall(body) : null;
  };

  const single = returning("", stripLeadingComments(code));
  if (single) {
    return single;
  }
  for (const boundary of boundaries.filter((index) => index < end).reverse()) {
    const tail = stripLeadingComments(code.slice(boundary));
    // After a newline or a block, a tail that continues the code before it
    // is not a statement of its own.
    if (!tail || (code[boundary - 1] !== ";" && CONTINUATION.test(tail))) {
      continue;
    }
    const wrapped = returning(code.slice(0, boundary), tail);
    if (wrapped) {
      return wrapped;
    }
  }

  // The last statement is not an expression, such as a declaration, so there
  // is no value to return.
  return asyncCall(expression);
}
