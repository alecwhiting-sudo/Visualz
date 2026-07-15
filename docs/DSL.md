# Visualz Expression DSL — v1 Specification

Design by the reasoner tier (2026-07-15), accepted by the architect. Target files:
`src/dsl/parse.ts`, `src/dsl/compile.ts`, `src/dsl/state.ts`, `src/dsl/builtins.ts`.

Benchmarked during design: the target expression `0.5 + bass * env(0.01,0.3,onset)`
evaluates in ~69 ns; a heavy expression with `noise + lfo + env + ternary + clamp` in
~113 ns — an order of magnitude under the 1 µs target. Closure-tree evaluation; no
`eval`/`new Function` anywhere.

---

## 1. Values, types, determinism model

- **One value type in v1: `number` (JS float64).** Every literal, signal, sub-expression,
  and result is a float64. GLSL v2 maps this to `float`. Booleans do not exist as a type;
  comparisons and logical ops produce `1.0`/`0.0`.
- **Truthiness** (for `!`, `&&`, `||`, ternary condition): a value is *true* iff `x != 0.0`.
- **Determinism.** `evaluate` reads only `env.time/dt/frame`, `env.signals`, and
  `env.state`. No `Date.now`, `performance.now`, `Math.random`. `noise` is a pure
  integer-hash function. All stateful helpers are pure functions of their per-frame inputs
  plus persistent state seeded deterministically and reset on seek. Same `src` + same
  `(dt, signals)` sequence from a fresh/`reset()` state ⇒ bit-identical outputs.

## 2. Grammar (EBNF)

Precedence is encoded by the Pratt table in §7; the EBNF is for shape only.

```
expr        := ternary
ternary     := logicalOr ( '?' expr ':' ternary )?        // right-assoc
logicalOr   := logicalAnd ( '||' logicalAnd )*
logicalAnd  := equality  ( '&&' equality )*
equality    := relational ( ('=='|'!=') relational )*
relational  := additive  ( ('<'|'<='|'>'|'>=') additive )*
additive    := multiplicative ( ('+'|'-') multiplicative )*
multiplicative := unary ( ('*'|'/'|'%') unary )*
unary       := ('-'|'!') unary | postfix
postfix     := primary                                     // (reserved for v2 swizzle .xy)
primary     := number | call | identifier | '(' expr ')'
call        := funcname '(' ( expr (',' expr)* )? ')'
number      := digit+ ('.' digit*)? exp?  |  '.' digit+ exp?
exp         := ('e'|'E') ('+'|'-')? digit+
identifier  := idstart idcont* ( '.' idcont+ )*            // dotted signal names
idstart     := 'a'..'z' | 'A'..'Z' | '_'
idcont      := idstart | '0'..'9'
funcname    := idstart idcont*                             // never dotted
```

Locked-in notes:
- GLSL-subset-shaped. No closures, strings, user definitions, or assignment.
  `vec2/vec3/vec4(...)` need zero grammar changes in v2 (new `call` names);
  in v1 they are simply "unknown function" errors.
- **Dotted identifiers** (`midi.cc.3`, `pad.x`) are a single identifier token whenever the
  token starts with a letter/underscore (`2.5` stays a number). Every dotted identifier in
  v1 is unambiguously a signal name. v2 swizzles reuse the same lexing, disambiguated by
  the compiler.
- `postfix` is a no-op passthrough in v1, present so v2 can attach `.swizzle` without
  restructuring the parser.

## 3. Names: reserved env, constants, builtins, signals

Resolution order for a bare (non-call) identifier:

1. **Reserved env values** → `time`, `dt`, `frame` (read from `EvalEnv`).
2. **Reserved constants** (compile-time folded): `pi = 3.141592653589793`,
   `tau = 6.283185307179586`, `e = 2.718281828459045`.
3. **Builtin function name used without `(`** → compile error:
   `'sin' is a builtin function; call it as sin(…)`.
4. **Otherwise** → signal read: `signals.get(name, 0)` at eval time.

**Unknown signal names read as 0 — not a compile error.** The signal set is dynamic
(MIDI CCs appear when a controller sends them; file vs mic paths publish differently);
compile errors would break valid expressions and replay on machines without the device.
Typo protection is soft: `CompiledExpr.signalRefs` lists referenced names
(first-appearance order, de-duplicated) so the UI can warn about unpublished signals.

### Pure builtins (v1 set, all 1:1 GLSL)

| name | arity | semantics | guard |
|---|---|---|---|
| `sin` `cos` `tan` | 1 | `Math.sin/cos/tan` | final sanitize only |
| `abs` | 1 | `Math.abs` | — |
| `sign` | 1 | `x<0?-1: x>0?1: 0` | — |
| `floor` `ceil` | 1 | `Math.floor/ceil` | — |
| `fract` | 1 | `x - Math.floor(x)` | — |
| `sqrt` | 1 | `Math.sqrt(Math.max(x,0))` | neg clamped to 0 |
| `exp` | 1 | `r=Math.exp(x); isFinite(r)?r:0` | overflow→0 |
| `log` | 1 | `x<=0 ? 0 : Math.log(x)` | domain→0 |
| `min` `max` | 2 | `Math.min/max` | — |
| `pow` | 2 | `r=Math.pow(a,b); isFinite(r)?r:0` | neg-base/0^neg→0 |
| `mod` | 2 | `b==0 ? 0 : a - b*floor(a/b)` (floor-based, = `%`) | /0→0 |
| `step` | 2 | `step(edge,x) = x<edge ? 0 : 1` | — |
| `clamp` | 3 | `min(max(x,lo),hi)` | — |
| `mix` | 3 | `a + (b-a)*t` (unclamped, GLSL semantics) | — |
| `smoothstep` | 3 | `e0==e1 ? (x<e0?0:1) : (t=clamp((x-e0)/(e1-e0),0,1), t*t*(3-2t))` | e0==e1 special-cased |
| `noise` | 1 | 1-D hash value noise, §5 | bounded [-1,1] |

## 4. Operators — exact semantics

| op | result |
|---|---|
| `+ - *` | IEEE float add/sub/mul |
| `/` | `b==0 ? 0 : a/b` |
| `%` | **floor-based mod** = `b==0 ? 0 : a - b*floor(a/b)` |
| unary `-` | negation |
| `!` | `x==0 ? 1 : 0` |
| `< <= > >=` | `1` if true else `0` |
| `== !=` | `1`/`0` (exact float equality, GLSL-matching) |
| `&&` | `(a!=0 && b!=0) ? 1 : 0` |
| `\|\|` | `(a!=0 \|\| b!=0) ? 1 : 0` |
| `?:` | `cond!=0 ? then : else` — right-assoc |

**`%` is floor-based `mod`, not C `fmod`.** GLSL has no float `%`; float remainder in GLSL
is `mod()`. So `-1 % 3 == 2` (not `-1`), `5.5 % 2 == 1.5`. User-visible; deserves an
editor tooltip.

**Branch semantics: eager for state, lazy for value.** `&&`, `||`, `?:` short-circuit
their *value* computation, but **every stateful helper advances every frame regardless of
branch** (hoisted out, run before the value tree). Pure sub-expressions have no side
effects, so their laziness is unobservable — matching GLSL (eager, side-effect-free).
Required for phase continuity and GLSL v2 compatibility.

## 5. `noise(x)` — exact algorithm

```ts
// 32-bit integer hash (Wellons "lowbias32"), uint32 via Math.imul.
// Input offset by golden-ratio constant so hash(0) != 0.
function hash32(x: number): number {
  x = (x + 0x9e3779b9) >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

function lattice(i: number): number {          // value at lattice point i, in [-1,1)
  const u = (i | 0) >>> 0                      // wrap negative to uint32
  return (hash32(u) / 4294967296) * 2 - 1
}

function noise(x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)                // Hermite fade (C1 continuity)
  const a = lattice(i)
  const b = lattice(i + 1)
  return a + (b - a) * u                       // in [-1, 1]
}
```

Output ∈ [-1,1], C1-continuous across integer boundaries, deterministic, table-free.
Transpiles verbatim to GLSL ES 3.0 (integer ops, `uint`, two's-complement cast all exist),
so v2 golden images stay identical. A `fract(sin(x)*k)` hash was rejected as
platform-divergent.

Reference values (tol 1e-6): `noise(0)=-0.984469733`, `noise(0.5)=-0.369915275`,
`noise(1)=0.244639182`, `noise(2)=-0.940450811`, `noise(2.5)=-0.909502386`,
`noise(-1)=0.288804224`, `noise(10.7)=-0.658551426`.

## 6. Stateful helpers — equations, state, keying

All three share a framerate-independent exponential-approach form. **Time parameters
(`halflife`, `attack`, `release`) are half-lives in seconds**: gap to target halves every
`h` seconds; per-frame retention `α = 2^(−dt/h)`.

Each helper sanitizes its arguments to finite before use
(`x = Number.isFinite(x) ? x : 0`) so persistent state can never be poisoned.

### `smooth(x, halflife)`
```
slot = state.slots[k]
if (slot === undefined) {                    // FIRST eval after fresh/reset: snap to x
  slot = { kind:'smooth', y: argX }
} else {
  const a = h > 0 ? Math.pow(2, -dt / h) : 0 // h<=0 ⇒ instant
  slot.y = argX + (slot.y - argX) * a
}
slot.value = slot.y
```
Reference (`smooth(x,0.3)`, snap to `x=1`, then `x=0`, dt=1/60):
`f0=1, f1=0.962223837, f2=0.925874712, f3=0.890898718`.

### `env(attack, release, trigger)`
```
target = trig > 0.5 ? 1 : 0
tau    = trig > 0.5 ? attack : release
slot   = state.slots[k] ?? { kind:'env', y: 0 }          // init at silence
const a = tau > 0 ? Math.pow(2, -dt / tau) : 0           // tau<=0 ⇒ snap
slot.y = target + (slot.y - target) * a
```
Reference (`env(0.01,0.3,trig)`, dt=1/60, trig=[1,1,0,0]):
`f0=0.685019738, f1=0.900787434, f2=0.866759141, f3=0.834016307`.

### `lfo(hz)` — phase-accumulated sine in [0,1]
```
slot = state.slots[k] ?? { kind:'lfo', phase: 0 }
slot.phase += hz * dt
slot.phase -= Math.floor(slot.phase)          // wrap into [0,1)
slot.value = 0.5 + 0.5 * Math.sin(2 * Math.PI * slot.phase)
```
Phase accumulation (not `sin(time*hz)`): correct FM behavior under live `hz` modulation,
bounded float precision over long sessions. Starting phase 0 ⇒ output `0.5` at t=0, rising.
Reference (`lfo(1)`, dt=1/60): `f0=0.552264232, f1=0.603955845, f2=0.654508497,
f3=0.703368322`; `lfo(0.25)` f0 = `0.513088474`.

### State keying (exact)

- A **resolve pass walks the AST post-order** and assigns each stateful node the next
  integer slot index `0,1,2,…`. Slot index is a pure function of the parse tree: same
  source ⇒ identical slots. Two textually-identical calls get distinct slots (distinct
  nodes).
- **Post-order guarantees dependency-correct advance order**: nested inner helpers get
  lower slots and advance first, so outer helpers see up-to-date inner values.
- Storage: `DslState.slots: HelperState[]`, lazily allocated. `exprId` is NOT used for
  keying (`EvalEnv.state` is already per-expression); retained for diagnostics only.
- `DslState.reset()` sets `slots.length = 0`; next frame re-initializes (smooth re-snaps,
  env→0, lfo→phase 0), restoring frame-0 behavior exactly.

```ts
// src/dsl/state.ts
type HelperState =
  | { kind: 'smooth'; y: number; value?: number }
  | { kind: 'env';    y: number; value?: number }
  | { kind: 'lfo';    phase: number; value?: number }

export class DslState {
  readonly slots: HelperState[] = []
  reset(): void { this.slots.length = 0 }
}
```

## 7. Tokenizer + Pratt parser

### Tokens
`NUMBER`, `IDENT` (may be dotted), `LPAREN` `RPAREN` `COMMA`, operators
`+ - * / % < <= > >= == != && || ! ? : =` (bare `=` lexes, then errors), `EOF`.
Every token carries `{ start, end }` char offsets. Whitespace ignored. Any other
character → `DslError` "unexpected character". A call is an `IDENT` immediately followed
by `(` — resolved during parse, not lexing.

### Precedence table (left-assoc unless noted)

| operator | binding power | assoc |
|---|---|---|
| `?:` | 2 | right |
| `\|\|` | 4 | left |
| `&&` | 6 | left |
| `== !=` | 8 | left |
| `< <= > >=` | 10 | left |
| `+ -` (binary) | 12 | left |
| `* / %` | 14 | left |
| unary `- !` | 16 (prefix) | right |
| call/group `(` | 18 | — |

Matches GLSL ES precedence for the supported subset. Left-assoc parses right operand with
`rbp = lbp`; right-assoc ternary with `rbp = lbp − 1`. Unary binds tighter than `*`:
`-2*3 → (-2)*3`, `2*-3 → 2*(-3)`.

### Parse algorithm (precedence-climbing)
```
parseExpr(rbp):
  left = nud()                      // number | ident | call | '(' expr ')' | prefix unary
  while lbp(peek) > rbp:
    left = led(left)                // binary op, or ternary '?'
  return left
```
- `nud` for `-`/`!`: consume, `arg = parseExpr(15)`, build `unary`.
- `led` for binary op power `p`: `right = parseExpr(p)`.
- `led` for `?`: `then = parseExpr(0)`, expect `:`, `else = parseExpr(1)`.
- `nud` for `IDENT` + `(`: parse comma-separated args to `)`, build `call`.
- After parsing, require `EOF`; leftover token → "unexpected token".

### Compile strategy (no `eval`/`new Function`)
1. `tokenize(src) → Token[]`
2. Pratt-parse → `Expr` AST
3. **Resolve pass** (post-order): fold `pi/tau/e`; classify bare idents as env/signal;
   validate calls (name ∈ builtins ∪ stateful, arity) else `DslError`; assign stateful
   slot indices; collect ordered stateful nodes; collect `signalRefs`.
4. **Codegen pass**: build a closure per node (`(env) => number`). Stateful nodes' *read*
   closures return `env.state.slots[k].value`; their *advance* closures are collected into
   `advances: ((env)=>void)[]` in slot order.
5. Return:
```ts
{ src,
  signalRefs,
  evaluate(env) {
    for (let i = 0; i < advances.length; i++) advances[i](env)  // eager helper advance
    const r = valueFn(env)
    return Number.isFinite(r) ? r : 0                           // totality backstop
  } }
```

### AST node union
```ts
type Expr =
  | { kind:'num';     value:number;                          start:number; end:number }
  | { kind:'signal';  name:string;                           start:number; end:number }
  | { kind:'env';     name:'time'|'dt'|'frame';              start:number; end:number }
  | { kind:'unary';   op:'-'|'!';    arg:Expr;               start:number; end:number }
  | { kind:'binary';  op:'+'|'-'|'*'|'/'|'%';  left:Expr; right:Expr;  start:number; end:number }
  | { kind:'compare'; op:'<'|'<='|'>'|'>='|'=='|'!=';  left:Expr; right:Expr; start:number; end:number }
  | { kind:'logical'; op:'&&'|'||';  left:Expr; right:Expr;  start:number; end:number }
  | { kind:'ternary'; cond:Expr; then:Expr; alt:Expr;        start:number; end:number }
  | { kind:'call';     name:string; args:Expr[];             start:number; end:number }
  | { kind:'stateful'; name:'smooth'|'env'|'lfo'; slot:number; args:Expr[]; start:number; end:number }
```

## 8. Safety / totality — guard strategy (three layers)

1. **Per-op guards** where non-finites commonly arise: `/0→0`, `%0→0`, `pow`/`exp`
   overflow→0, `sqrt`/`log` domain→0. Single compare each — negligible cost.
2. **Finite-clamp of every stateful-helper argument** — the load-bearing guard: one NaN
   reaching `slot.y`/`slot.phase` would corrupt output forever.
3. **Final boundary sanitize** in `evaluate`: `Number.isFinite(r) ? r : 0` (catches e.g.
   `1e300*1e300`, where per-`*` guards would tax the common path).

A boundary-only clamp is insufficient: it can't protect persistent state, and NaN through
comparisons silently picks branches (`NaN < 1` is `false`). Sanitize fallback is `0`.

## 9. Error cases (`DslError` with `{ start, end }` + message)

`start/end` are char offsets; for end-of-input errors, `start = end = src.length`.

| # | trigger | example | message |
|---|---|---|---|
| E1 | empty/whitespace source | `""` | "empty expression" |
| E2 | unexpected character | `1 @ 2` | "unexpected character '@'" |
| E3 | expected expression | `1 +`, `* 2` | "expected expression" |
| E4 | unterminated paren | `(1 + 2` | "expected ')'" |
| E5 | trailing tokens | `1 2` | "unexpected token '2'" |
| E6 | unknown function | `foo(1)`, `vec2(1,2)` | "unknown function 'foo'" |
| E7 | wrong arity | `sin(1,2)`, `max()` | "sin expects 1 argument, got 2" |
| E8 | builtin as value | `sin + 1` | "'sin' is a builtin function; call it as sin(…)" |
| E9 | ternary missing `:` | `a ? b` | "expected ':'" |
| E10 | empty parens | `()` | "expected expression" |
| E11 | misplaced comma | `min(1,)` | "expected expression" |
| E12 | malformed number | `1.2.3` | "unexpected token" (via E5) |
| E13 | assignment attempt | `x = 1` | "unexpected token '='" |

Signal names are never errors (unknown ⇒ 0). Division/domain issues are never parse
errors (runtime-guarded).

## 10. Unit test cases

See `tests/unit/dsl.test.ts` — the 76 cases from the design review are transcribed there:
literals/precedence (1–15), comparisons/logical/ternary (16–26), signals/env (27–31),
pure builtins (32–45), stateful helpers (46–55), eager-branch/determinism/reset (56–60),
totality/guards (61–64), errors (65–76). Reference values in §5–§6 above.

## 11. Accepted design flags

1. `exprId` is redundant for keying (state is per-expression) — kept for diagnostics.
2. `%` diverges from JS/C (floor-based) for GLSL compatibility — editor tooltip needed.
3. `smooth/env` time params are **half-lives**, not time-to-target — editor tooltip needed.
4. Stateful helpers don't transpile to GLSL in v2 — the pure subset transpiles verbatim;
   helpers become CPU-computed uniforms. The AST's `stateful` node split exists for this.
