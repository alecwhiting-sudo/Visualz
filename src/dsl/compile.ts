/**
 * Resolve pass + closure-tree codegen for the expression DSL (docs/DSL.md §7). No
 * `eval`/`new Function` anywhere — every AST node compiles to a small `(env) => number`
 * closure, composed into a tree. Stateful helpers (`smooth`/`env`/`lfo`) are hoisted
 * into a separate `advances` array keyed by slot index, run unconditionally every frame
 * before the value tree — this is what makes phase/decay continuity survive untaken
 * ternary/`&&`/`||` branches (docs/DSL.md §4, §8).
 */

import { type BuiltinDef, builtins } from './builtins'
import { type Expr, DslError, parse } from './parse'
import type { DslState, HelperState } from './state'

export interface EvalEnv {
  time: number
  dt: number
  frame: number
  signals: { get(name: string, fallback?: number): number }
  state: DslState
}

export interface CompiledExpr {
  readonly src: string
  readonly signalRefs: readonly string[]
  evaluate(env: EvalEnv): number
}

const STATEFUL_ARITY = { smooth: 2, env: 3, lfo: 1 } as const

function arityMessage(name: string, expected: number, got: number): string {
  return `${name} expects ${expected} argument${expected === 1 ? '' : 's'}, got ${got}`
}

interface ResolveCtx {
  signalRefs: string[]
  signalSeen: Set<string>
  nextSlot: number
}

/**
 * Post-order resolve: fold `pi`/`tau`/`e`, classify bare identifiers as env/signal,
 * validate calls (builtin or stateful helper, arity), assign stateful slot indices, and
 * collect `signalRefs` in first-appearance order. Children are always resolved before
 * the parent — this is what gives stateful helpers dependency-correct slot order
 * (inner helpers get lower slots, so they advance before outer helpers read them).
 */
function resolve(node: Expr, ctx: ResolveCtx): Expr {
  switch (node.kind) {
    case 'num':
      return node

    case 'signal': {
      const name = node.name
      if (name === 'time' || name === 'dt' || name === 'frame') {
        return { kind: 'env', name, start: node.start, end: node.end }
      }
      if (name === 'pi') return { kind: 'num', value: Math.PI, start: node.start, end: node.end }
      if (name === 'tau')
        return { kind: 'num', value: 2 * Math.PI, start: node.start, end: node.end }
      if (name === 'e') return { kind: 'num', value: Math.E, start: node.start, end: node.end }
      if (name in builtins) {
        throw new DslError(
          `'${name}' is a builtin function; call it as ${name}(…)`,
          node.start,
          node.end,
        )
      }
      if (!ctx.signalSeen.has(name)) {
        ctx.signalSeen.add(name)
        ctx.signalRefs.push(name)
      }
      return node
    }

    case 'unary':
      return { ...node, arg: resolve(node.arg, ctx) }

    case 'binary':
    case 'compare':
    case 'logical':
      return { ...node, left: resolve(node.left, ctx), right: resolve(node.right, ctx) }

    case 'ternary':
      return {
        ...node,
        cond: resolve(node.cond, ctx),
        then: resolve(node.then, ctx),
        alt: resolve(node.alt, ctx),
      }

    case 'call': {
      const name = node.name
      if (name === 'smooth' || name === 'env' || name === 'lfo') {
        const arity = STATEFUL_ARITY[name]
        if (node.args.length !== arity) {
          throw new DslError(
            arityMessage(name, arity, node.args.length),
            node.start,
            node.end,
          )
        }
        const args = node.args.map((a) => resolve(a, ctx))
        const slot = ctx.nextSlot++
        return { kind: 'stateful', name, slot, args, start: node.start, end: node.end }
      }
      const def = builtins[name]
      if (!def) {
        throw new DslError(`unknown function '${name}'`, node.start, node.end)
      }
      if (node.args.length !== def.arity) {
        throw new DslError(
          arityMessage(name, def.arity, node.args.length),
          node.start,
          node.end,
        )
      }
      return { ...node, args: node.args.map((a) => resolve(a, ctx)) }
    }

    // Parser never produces these directly; present for exhaustiveness.
    case 'env':
    case 'stateful':
      return node
  }
}

type ValueFn = (env: EvalEnv) => number
type AdvanceFn = (env: EvalEnv) => void

/** `x` sanitized to finite, per docs/DSL.md §6 — the load-bearing guard for state. */
function finite(x: number): number {
  return Number.isFinite(x) ? x : 0
}

function compileStateful(
  node: Extract<Expr, { kind: 'stateful' }>,
  advances: AdvanceFn[],
): ValueFn {
  const slot = node.slot
  const argFns = node.args.map((a) => compileNode(a, advances))

  if (node.name === 'smooth') {
    const [xFn, hFn] = argFns
    advances[slot] = (env) => {
      const x = finite(xFn(env))
      const h = finite(hFn(env))
      let s = env.state.slots[slot] as Extract<HelperState, { kind: 'smooth' }> | undefined
      if (s === undefined) {
        s = { kind: 'smooth', y: x } // first eval after fresh/reset: snap to x
        env.state.slots[slot] = s
      } else {
        const a = h > 0 ? Math.pow(2, -env.dt / h) : 0
        s.y = x + (s.y - x) * a
      }
      s.value = s.y
    }
  } else if (node.name === 'env') {
    const [attackFn, releaseFn, trigFn] = argFns
    advances[slot] = (env) => {
      const attack = finite(attackFn(env))
      const release = finite(releaseFn(env))
      const trig = finite(trigFn(env))
      let s = env.state.slots[slot] as Extract<HelperState, { kind: 'env' }> | undefined
      if (s === undefined) {
        s = { kind: 'env', y: 0 } // init at silence
        env.state.slots[slot] = s
      }
      const target = trig > 0.5 ? 1 : 0
      const tau = trig > 0.5 ? attack : release
      const a = tau > 0 ? Math.pow(2, -env.dt / tau) : 0
      s.y = target + (s.y - target) * a
      s.value = s.y
    }
  } else {
    // lfo
    const [hzFn] = argFns
    advances[slot] = (env) => {
      const hz = finite(hzFn(env))
      let s = env.state.slots[slot] as Extract<HelperState, { kind: 'lfo' }> | undefined
      if (s === undefined) {
        s = { kind: 'lfo', phase: 0 }
        env.state.slots[slot] = s
      }
      s.phase += hz * env.dt
      s.phase -= Math.floor(s.phase)
      s.value = 0.5 + 0.5 * Math.sin(2 * Math.PI * s.phase)
    }
  }

  return (env) => env.state.slots[slot]?.value ?? 0
}

function compileNode(node: Expr, advances: AdvanceFn[]): ValueFn {
  switch (node.kind) {
    case 'num': {
      const v = node.value
      return () => v
    }

    case 'env': {
      if (node.name === 'time') return (env) => env.time
      if (node.name === 'dt') return (env) => env.dt
      return (env) => env.frame
    }

    case 'signal': {
      const name = node.name
      return (env) => env.signals.get(name, 0)
    }

    case 'unary': {
      const argFn = compileNode(node.arg, advances)
      if (node.op === '-') return (env) => -argFn(env)
      return (env) => (argFn(env) === 0 ? 1 : 0)
    }

    case 'binary': {
      const leftFn = compileNode(node.left, advances)
      const rightFn = compileNode(node.right, advances)
      switch (node.op) {
        case '+':
          return (env) => leftFn(env) + rightFn(env)
        case '-':
          return (env) => leftFn(env) - rightFn(env)
        case '*':
          return (env) => leftFn(env) * rightFn(env)
        case '/':
          return (env) => {
            const a = leftFn(env)
            const b = rightFn(env)
            return b === 0 ? 0 : a / b
          }
        case '%':
          return (env) => {
            const a = leftFn(env)
            const b = rightFn(env)
            return b === 0 ? 0 : a - b * Math.floor(a / b)
          }
      }
      break
    }

    case 'compare': {
      const leftFn = compileNode(node.left, advances)
      const rightFn = compileNode(node.right, advances)
      switch (node.op) {
        case '<':
          return (env) => (leftFn(env) < rightFn(env) ? 1 : 0)
        case '<=':
          return (env) => (leftFn(env) <= rightFn(env) ? 1 : 0)
        case '>':
          return (env) => (leftFn(env) > rightFn(env) ? 1 : 0)
        case '>=':
          return (env) => (leftFn(env) >= rightFn(env) ? 1 : 0)
        case '==':
          return (env) => (leftFn(env) === rightFn(env) ? 1 : 0)
        case '!=':
          return (env) => (leftFn(env) !== rightFn(env) ? 1 : 0)
      }
      break
    }

    case 'logical': {
      // Lazy value evaluation (short-circuit); stateful args still advance every frame
      // via the hoisted `advances` list, independent of this closure. §4.
      const leftFn = compileNode(node.left, advances)
      const rightFn = compileNode(node.right, advances)
      if (node.op === '&&') {
        return (env) => (leftFn(env) !== 0 ? (rightFn(env) !== 0 ? 1 : 0) : 0)
      }
      return (env) => (leftFn(env) !== 0 ? 1 : rightFn(env) !== 0 ? 1 : 0)
    }

    case 'ternary': {
      const condFn = compileNode(node.cond, advances)
      const thenFn = compileNode(node.then, advances)
      const altFn = compileNode(node.alt, advances)
      return (env) => (condFn(env) !== 0 ? thenFn(env) : altFn(env))
    }

    case 'call': {
      const def = builtins[node.name] as BuiltinDef
      const argFns = node.args.map((a) => compileNode(a, advances))
      // Scratch array reused across frames: builtins consume it synchronously and never
      // retain it, and nested call nodes each own their own scratch, so in-place fill is
      // safe and avoids per-eval allocation (~50 exprs/frame at 60fps).
      const scratch = new Array<number>(argFns.length)
      return (env) => {
        for (let i = 0; i < argFns.length; i++) scratch[i] = argFns[i](env)
        return def.call(scratch)
      }
    }

    case 'stateful':
      return compileStateful(node, advances)
  }
  throw new Error(`internal: no codegen for node kind`)
}

/**
 * Compiles `src` into a closure tree. `exprId` is not used for state keying — `env.state`
 * is already per-expression (docs/DSL.md §6) — it is retained only so callers can tag
 * diagnostics with which expression a compiled closure came from.
 */
export function compile(src: string, exprId: string): CompiledExpr {
  void exprId // diagnostics only, see docstring
  const raw = parse(src)
  const ctx: ResolveCtx = { signalRefs: [], signalSeen: new Set(), nextSlot: 0 }
  const resolved = resolve(raw, ctx)
  const advances: AdvanceFn[] = new Array(ctx.nextSlot)
  const valueFn = compileNode(resolved, advances)
  const signalRefs = ctx.signalRefs

  return {
    src,
    signalRefs,
    evaluate(env: EvalEnv): number {
      for (let i = 0; i < advances.length; i++) advances[i](env)
      const r = valueFn(env)
      return Number.isFinite(r) ? r : 0
    },
  }
}
