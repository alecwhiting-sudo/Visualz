/**
 * Tokenizer + Pratt (precedence-climbing) parser for the expression DSL. Produces the
 * final AST union directly (docs/DSL.md §7): bare identifiers become `signal` nodes and
 * every `name(...)` becomes a `call` node at parse time — the resolve pass in compile.ts
 * later reclassifies `signal` nodes into `env`/folded `num` where the name is reserved,
 * and `call` nodes into `stateful` where the name is a stateful helper. No `eval`/
 * `new Function`; grammar and precedence exactly match docs/DSL.md §2/§7.
 */

export class DslError extends Error {
  readonly start: number
  readonly end: number

  constructor(message: string, start: number, end: number) {
    super(message)
    this.name = 'DslError'
    this.start = start
    this.end = end
  }
}

export type Expr =
  | { kind: 'num'; value: number; start: number; end: number }
  | { kind: 'signal'; name: string; start: number; end: number }
  | { kind: 'env'; name: 'time' | 'dt' | 'frame'; start: number; end: number }
  | { kind: 'unary'; op: '-' | '!'; arg: Expr; start: number; end: number }
  | {
      kind: 'binary'
      op: '+' | '-' | '*' | '/' | '%'
      left: Expr
      right: Expr
      start: number
      end: number
    }
  | {
      kind: 'compare'
      op: '<' | '<=' | '>' | '>='
        | '==' | '!='
      left: Expr
      right: Expr
      start: number
      end: number
    }
  | {
      kind: 'logical'
      op: '&&' | '||'
      left: Expr
      right: Expr
      start: number
      end: number
    }
  | { kind: 'ternary'; cond: Expr; then: Expr; alt: Expr; start: number; end: number }
  | { kind: 'call'; name: string; args: Expr[]; start: number; end: number }
  | {
      kind: 'stateful'
      name: 'smooth' | 'env' | 'lfo'
      slot: number
      args: Expr[]
      start: number
      end: number
    }

type TokenType =
  | 'num'
  | 'ident'
  | '('
  | ')'
  | ','
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | '&&'
  | '||'
  | '!'
  | '?'
  | ':'
  | '='
  | 'eof'

interface Token {
  type: TokenType
  start: number
  end: number
  value?: number // for 'num'
  name?: string // for 'ident'
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9'
}

function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_')
}

function isIdentCont(c: string | undefined): boolean {
  return isIdentStart(c) || isDigit(c)
}

function readNumber(src: string, start: number): { end: number; value: number } {
  let i = start
  if (src[i] === '.') {
    i++
    while (isDigit(src[i])) i++
  } else {
    while (isDigit(src[i])) i++
    if (src[i] === '.') {
      i++
      while (isDigit(src[i])) i++
    }
  }
  if (src[i] === 'e' || src[i] === 'E') {
    let j = i + 1
    if (src[j] === '+' || src[j] === '-') j++
    if (isDigit(src[j])) {
      i = j
      while (isDigit(src[i])) i++
    }
  }
  return { end: i, value: Number(src.slice(start, i)) }
}

function readIdent(src: string, start: number): { end: number; name: string } {
  let i = start + 1
  while (isIdentCont(src[i])) i++
  while (src[i] === '.' && isIdentCont(src[i + 1])) {
    i++
    while (isIdentCont(src[i])) i++
  }
  return { end: i, name: src.slice(start, i) }
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    const start = i
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const { end, value } = readNumber(src, start)
      tokens.push({ type: 'num', start, end, value })
      i = end
      continue
    }
    if (isIdentStart(c)) {
      const { end, name } = readIdent(src, start)
      tokens.push({ type: 'ident', start, end, name })
      i = end
      continue
    }
    switch (c) {
      case '(':
      case ')':
      case ',':
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
      case '?':
      case ':':
        tokens.push({ type: c, start, end: start + 1 })
        i++
        break
      case '<':
        if (src[i + 1] === '=') {
          tokens.push({ type: '<=', start, end: start + 2 })
          i += 2
        } else {
          tokens.push({ type: '<', start, end: start + 1 })
          i++
        }
        break
      case '>':
        if (src[i + 1] === '=') {
          tokens.push({ type: '>=', start, end: start + 2 })
          i += 2
        } else {
          tokens.push({ type: '>', start, end: start + 1 })
          i++
        }
        break
      case '=':
        if (src[i + 1] === '=') {
          tokens.push({ type: '==', start, end: start + 2 })
          i += 2
        } else {
          tokens.push({ type: '=', start, end: start + 1 })
          i++
        }
        break
      case '!':
        if (src[i + 1] === '=') {
          tokens.push({ type: '!=', start, end: start + 2 })
          i += 2
        } else {
          tokens.push({ type: '!', start, end: start + 1 })
          i++
        }
        break
      case '&':
        if (src[i + 1] === '&') {
          tokens.push({ type: '&&', start, end: start + 2 })
          i += 2
        } else {
          throw new DslError(`unexpected character '&'`, start, start + 1)
        }
        break
      case '|':
        if (src[i + 1] === '|') {
          tokens.push({ type: '||', start, end: start + 2 })
          i += 2
        } else {
          throw new DslError(`unexpected character '|'`, start, start + 1)
        }
        break
      default:
        throw new DslError(`unexpected character '${c}'`, start, start + 1)
    }
  }
  tokens.push({ type: 'eof', start: n, end: n })
  return tokens
}

/** Left binding power. Tokens absent from this table act as lbp 0 (loop terminator). */
const LBP: Partial<Record<TokenType, number>> = {
  '?': 2,
  '||': 4,
  '&&': 6,
  '==': 8,
  '!=': 8,
  '<': 10,
  '<=': 10,
  '>': 10,
  '>=': 10,
  '+': 12,
  '-': 12,
  '*': 14,
  '/': 14,
  '%': 14,
}

class Parser {
  private pos = 0

  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos]
  }

  private next(): Token {
    return this.tokens[this.pos++]
  }

  /** Source text of a token, for "unexpected token '…'" messages. */
  private text(tok: Token): string {
    return this.src.slice(tok.start, tok.end)
  }

  parseExpr(rbp: number): Expr {
    let left = this.nud()
    while ((LBP[this.peek().type] ?? 0) > rbp) {
      const tok = this.next()
      left = this.led(left, tok)
    }
    return left
  }

  private nud(): Expr {
    const tok = this.next()
    switch (tok.type) {
      case 'num':
        return { kind: 'num', value: tok.value as number, start: tok.start, end: tok.end }
      case 'ident': {
        const name = tok.name as string
        if (this.peek().type === '(') {
          this.next() // consume '('
          const args: Expr[] = []
          if (this.peek().type !== ')') {
            args.push(this.parseExpr(0))
            while (this.peek().type === ',') {
              this.next()
              args.push(this.parseExpr(0))
            }
          }
          const closeTok = this.peek()
          if (closeTok.type !== ')') {
            throw new DslError("expected ')'", closeTok.start, closeTok.end)
          }
          this.next() // consume ')'
          return { kind: 'call', name, args, start: tok.start, end: closeTok.end }
        }
        return { kind: 'signal', name, start: tok.start, end: tok.end }
      }
      case '(': {
        const inner = this.parseExpr(0)
        const closeTok = this.peek()
        if (closeTok.type !== ')') {
          throw new DslError("expected ')'", closeTok.start, closeTok.end)
        }
        this.next() // consume ')'
        return inner
      }
      case '-':
      case '!': {
        const arg = this.parseExpr(15)
        return { kind: 'unary', op: tok.type, arg, start: tok.start, end: arg.end }
      }
      default:
        throw new DslError('expected expression', tok.start, tok.end)
    }
  }

  private led(left: Expr, tok: Token): Expr {
    switch (tok.type) {
      case '?': {
        const then = this.parseExpr(0)
        const colon = this.peek()
        if (colon.type !== ':') {
          throw new DslError("expected ':'", colon.start, colon.end)
        }
        this.next() // consume ':'
        const alt = this.parseExpr(1)
        return { kind: 'ternary', cond: left, then, alt, start: left.start, end: alt.end }
      }
      case '||':
      case '&&': {
        const right = this.parseExpr(LBP[tok.type] as number)
        return { kind: 'logical', op: tok.type, left, right, start: left.start, end: right.end }
      }
      case '==':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const right = this.parseExpr(LBP[tok.type] as number)
        return { kind: 'compare', op: tok.type, left, right, start: left.start, end: right.end }
      }
      case '+':
      case '-':
      case '*':
      case '/':
      case '%': {
        const right = this.parseExpr(LBP[tok.type] as number)
        return { kind: 'binary', op: tok.type, left, right, start: left.start, end: right.end }
      }
      default:
        // Unreachable: parseExpr's loop only calls led() for tokens present in LBP.
        throw new DslError(`unexpected token '${this.text(tok)}'`, tok.start, tok.end)
    }
  }

  finish(): Expr {
    const result = this.parseExpr(0)
    const tok = this.peek()
    if (tok.type !== 'eof') {
      throw new DslError(`unexpected token '${this.text(tok)}'`, tok.start, tok.end)
    }
    return result
  }
}

export function parse(src: string): Expr {
  const tokens = tokenize(src)
  if (tokens.length === 1) {
    // Only the EOF token: empty or whitespace-only source.
    throw new DslError('empty expression', src.length, src.length)
  }
  return new Parser(tokens, src).finish()
}
