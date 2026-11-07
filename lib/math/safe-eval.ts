// lib/math/safe-eval.ts
//
// Small, safe arithmetic evaluator for AI-written computations. The solver
// writes the arithmetic as an expression ("(1241)/5", "2*sqrt(3)") and we do
// the arithmetic here instead of trusting the model's mental math (Math
// Module 001 Q17: 248.2 came back as 249). Never uses eval/Function: a
// hand-written recursive-descent parser over a fixed grammar:
//
//   expr    := term (("+" | "-") term)*
//   term    := unary (("*" | "/") unary)*
//   unary   := ("+" | "-") unary | power
//   power   := primary (("^" | "**") unary)?        (right-associative)
//   primary := number | name | name "(" args ")" | "(" expr ")"
//
// Names: constants (pi, e), the caller's variables (e.g. ans) and a fixed
// list of math functions. "math." / "Math." prefixes are accepted.

export class SafeEvalError extends Error {}

const MAX_LEN = 500;
const MAX_DEPTH = 60;

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const FUNCTIONS: Record<string, { arity: [number, number]; fn: (...a: number[]) => number }> = {
  sqrt: { arity: [1, 1], fn: Math.sqrt },
  cbrt: { arity: [1, 1], fn: Math.cbrt },
  abs: { arity: [1, 1], fn: Math.abs },
  floor: { arity: [1, 1], fn: Math.floor },
  ceil: { arity: [1, 1], fn: Math.ceil },
  exp: { arity: [1, 1], fn: Math.exp },
  ln: { arity: [1, 1], fn: Math.log },
  log: { arity: [1, 2], fn: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)) },
  log10: { arity: [1, 1], fn: Math.log10 },
  log2: { arity: [1, 1], fn: Math.log2 },
  sin: { arity: [1, 1], fn: Math.sin },
  cos: { arity: [1, 1], fn: Math.cos },
  tan: { arity: [1, 1], fn: Math.tan },
  asin: { arity: [1, 1], fn: Math.asin },
  acos: { arity: [1, 1], fn: Math.acos },
  atan: { arity: [1, 1], fn: Math.atan },
  radians: { arity: [1, 1], fn: (d) => (d * Math.PI) / 180 },
  degrees: { arity: [1, 1], fn: (r) => (r * 180) / Math.PI },
  min: { arity: [1, 20], fn: Math.min },
  max: { arity: [1, 20], fn: Math.max },
  pow: { arity: [2, 2], fn: Math.pow },
};

type Tok =
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "^" | "(" | ")" | "," };

function tokenize(src: string): Tok[] {
  const s = src
    .normalize("NFKC")
    .replace(/[−‒–—]/g, "-")
    .replace(/[×·]/g, "*")
    .replace(/÷/g, "/")
    .replace(/π/g, "pi")
    .replace(/√/g, "sqrt");
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z_0-9]*(\.[A-Za-z_][A-Za-z_0-9]*)?/.exec(s.slice(i));
    if (name) {
      out.push({ t: "name", v: name[0].replace(/^math\./i, "").toLowerCase() });
      i += name[0].length;
      continue;
    }
    if (s.startsWith("**", i)) {
      out.push({ t: "op", v: "^" });
      i += 2;
      continue;
    }
    if ("+-*/^(),".includes(c)) {
      out.push({ t: "op", v: c as "+" });
      i++;
      continue;
    }
    throw new SafeEvalError(`unexpected character "${c}"`);
  }
  return out;
}

/**
 * Evaluate an arithmetic expression. `vars` supplies named values (keys are
 * matched case-insensitively). Throws SafeEvalError on anything outside the
 * grammar, an unknown name, or a non-finite result.
 */
export function safeEvaluate(expression: string, vars: Record<string, number> = {}): number {
  if (typeof expression !== "string" || !expression.trim()) throw new SafeEvalError("empty expression");
  if (expression.length > MAX_LEN) throw new SafeEvalError("expression too long");
  const scope: Record<string, number> = {};
  for (const [k, v] of Object.entries(vars)) scope[k.toLowerCase()] = v;
  const toks = tokenize(expression);
  let pos = 0;
  let depth = 0;

  const peek = () => toks[pos];
  const isOp = (v: string) => {
    const t = toks[pos];
    return !!t && t.t === "op" && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new SafeEvalError(`expected "${v}"`);
    pos++;
  };
  const enter = () => {
    if (++depth > MAX_DEPTH) throw new SafeEvalError("expression nested too deeply");
  };

  function expr(): number {
    enter();
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = (toks[pos++] as { v: string }).v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    depth--;
    return v;
  }
  function term(): number {
    let v = unary();
    while (isOp("*") || isOp("/")) {
      const op = (toks[pos++] as { v: string }).v;
      const r = unary();
      if (op === "/" && r === 0) throw new SafeEvalError("division by zero");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function unary(): number {
    enter();
    let v: number;
    if (isOp("-")) {
      pos++;
      v = -unary();
    } else if (isOp("+")) {
      pos++;
      v = unary();
    } else {
      v = power();
    }
    depth--;
    return v;
  }
  function power(): number {
    const base = primary();
    if (isOp("^")) {
      pos++;
      return Math.pow(base, unary());
    }
    return base;
  }
  function primary(): number {
    const t = peek();
    if (!t) throw new SafeEvalError("unexpected end of expression");
    if (t.t === "num") {
      pos++;
      return t.v;
    }
    if (t.t === "name") {
      pos++;
      if (isOp("(")) {
        const f = Object.hasOwn(FUNCTIONS, t.v) ? FUNCTIONS[t.v] : undefined;
        if (!f) throw new SafeEvalError(`unknown function "${t.v}"`);
        pos++;
        const args: number[] = [];
        if (!isOp(")")) {
          args.push(expr());
          while (isOp(",")) {
            pos++;
            args.push(expr());
          }
        }
        expect(")");
        if (args.length < f.arity[0] || args.length > f.arity[1]) {
          throw new SafeEvalError(`${t.v}() takes ${f.arity[0]}–${f.arity[1]} arguments`);
        }
        return f.fn(...args);
      }
      if (Object.hasOwn(scope, t.v)) return scope[t.v];
      if (Object.hasOwn(CONSTANTS, t.v)) return CONSTANTS[t.v];
      throw new SafeEvalError(`unknown name "${t.v}"`);
    }
    if (t.v === "(") {
      pos++;
      const v = expr();
      expect(")");
      return v;
    }
    throw new SafeEvalError(`unexpected "${t.v}"`);
  }

  const value = expr();
  if (pos !== toks.length) throw new SafeEvalError("unexpected text after the expression");
  if (!Number.isFinite(value)) throw new SafeEvalError("result is not a finite number");
  return value;
}

/** safeEvaluate that returns null instead of throwing. */
export function tryEvaluate(expression: string, vars?: Record<string, number>): number | null {
  try {
    return safeEvaluate(expression, vars);
  } catch {
    return null;
  }
}

/** Values are equal within a relative tolerance (default 1e-6). */
export function nearlyEqual(a: number, b: number, rel = 1e-6): boolean {
  return Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Plug-back check: an equation such as "3*ans + 7 == 31" (or "=") must hold
 * for the given variables. Returns null when the equation can't be read.
 */
export function equationHolds(equation: string, vars: Record<string, number>): boolean | null {
  const parts = equation.split(/==|(?<![<>!])=(?!=)/);
  if (parts.length !== 2) return null;
  const l = tryEvaluate(parts[0], vars);
  const r = tryEvaluate(parts[1], vars);
  if (l === null || r === null) return null;
  return nearlyEqual(l, r);
}
