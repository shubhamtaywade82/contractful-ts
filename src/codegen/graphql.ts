/**
 * Hand-written GraphQL SDL parser (zero dependencies).
 *
 * Understands the type-system subset needed for client generation:
 * `schema`, `type`, `input`, `interface`, `enum`, `union`, `scalar`,
 * `extend type`, descriptions (block strings and `#` comments), argument
 * lists with defaults, `@deprecated` and nullability modifiers
 * (`T`, `T!`, `[T]`, `[T!]!`, ...).
 */

export interface GqlTypeRef {
  kind: 'named' | 'list';
  /** For `named` refs. */
  name?: string;
  /** For `list` refs. */
  of?: GqlTypeRef;
  /** `true` when the ref carries a trailing `!`. */
  nonNull: boolean;
}

export interface GqlArg {
  name: string;
  type: GqlTypeRef;
  description?: string;
  defaultValue?: string;
}

export interface GqlField {
  name: string;
  type: GqlTypeRef;
  args: GqlArg[];
  description?: string;
  deprecated?: boolean;
}

export interface GqlObjectType {
  name: string;
  kind: 'type' | 'input' | 'interface';
  description?: string;
  fields: GqlField[];
  interfaces: string[];
}

export interface GqlDocument {
  types: Map<string, GqlObjectType>;
  enums: Map<string, string[]>;
  unions: Map<string, string[]>;
  scalars: Set<string>;
  roots: { query?: string; mutation?: string; subscription?: string };
  queries: GqlField[];
  mutations: GqlField[];
  subscriptions: GqlField[];
}

export class GraphQLParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = 'GraphQLParseError';
  }
}

/* -------------------------------------------------------------------------- */
/* Tokenizer                                                                   */
/* -------------------------------------------------------------------------- */

type TokenKind = 'name' | 'punct' | 'string' | 'blockString' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
}

const PUNCTUATION = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '=', '@', '|', '&', '...']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;

  while (i < source.length) {
    const char = source[i]!;

    if (char === '\n') {
      line++;
      i++;
      continue;
    }
    if (char === '\r' || char === '\t' || char === ' ' || char === ',') {
      i++;
      continue;
    }
    if (char === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (char === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GraphQLParseError('Unterminated block string', line);
        const value = source.slice(i + 3, end);
        line += (value.match(/\n/g) ?? []).length;
        tokens.push({ kind: 'blockString', value, line });
        i = end + 3;
        continue;
      }
      const end = source.indexOf('"', i + 1);
      if (end === -1) throw new GraphQLParseError('Unterminated string', line);
      tokens.push({ kind: 'string', value: source.slice(i + 1, end), line });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j), line });
      i = j;
      continue;
    }
    if (PUNCTUATION.has(char)) {
      tokens.push({ kind: 'punct', value: char, line });
      i++;
      continue;
    }
    if (char === '-' || /[0-9]/.test(char)) {
      // Numeric default values — scanned loosely as names.
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j), line });
      i = j;
      continue;
    }
    throw new GraphQLParseError(`Unexpected character ${JSON.stringify(char)}`, line);
  }
  tokens.push({ kind: 'eof', value: '', line });
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                      */
/* -------------------------------------------------------------------------- */

class Parser {
  #tokens: Token[];
  #pos = 0;

  constructor(source: string) {
    this.#tokens = tokenize(source);
  }

  #peek(offset = 0): Token {
    return this.#tokens[Math.min(this.#pos + offset, this.#tokens.length - 1)]!;
  }

  #next(): Token {
    return this.#tokens[this.#pos++] ?? this.#tokens[this.#tokens.length - 1]!;
  }

  #expectPunct(value: string): void {
    const token = this.#next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLParseError(`Expected ${JSON.stringify(value)}, got ${describe(token)}`, token.line);
    }
  }

  #expectName(): string {
    const token = this.#next();
    if (token.kind !== 'name') {
      throw new GraphQLParseError(`Expected a name, got ${describe(token)}`, token.line);
    }
    return token.value;
  }

  #acceptPunct(value: string): boolean {
    const token = this.#peek();
    if (token.kind === 'punct' && token.value === value) {
      this.#pos++;
      return true;
    }
    return false;
  }

  /** Consumes a description (block string or plain string) preceding a definition. */
  #takeDescription(): string | undefined {
    const token = this.#peek();
    if (token.kind === 'blockString' || token.kind === 'string') {
      this.#pos++;
      return token.value.trim();
    }
    return undefined;
  }

  parseDocument(): GqlDocument {
    const doc: GqlDocument = {
      types: new Map(),
      enums: new Map(),
      unions: new Map(),
      scalars: new Set(),
      roots: {},
      queries: [],
      mutations: [],
      subscriptions: [],
    };

    while (this.#peek().kind !== 'eof') {
      const description = this.#takeDescription();
      const keyword = this.#expectName();

      switch (keyword) {
        case 'schema':
          this.#parseSchema(doc);
          break;
        case 'type':
          this.#parseType(doc, description, false);
          break;
        case 'extend':
          this.#parseExtend(doc);
          break;
        case 'input':
          this.#parseType(doc, description, true);
          break;
        case 'interface':
          this.#parseInterface(doc, description);
          break;
        case 'enum':
          this.#parseEnum(doc, description);
          break;
        case 'union':
          this.#parseUnion(doc, description);
          break;
        case 'scalar':
          this.#parseScalar(doc, description);
          break;
        case 'directive':
          this.#skipDirectiveDefinition();
          break;
        default:
          throw new GraphQLParseError(
            `Unexpected top-level keyword ${JSON.stringify(keyword)}`,
            this.#peek().line,
          );
      }
    }

    resolveRoots(doc);
    return doc;
  }

  #parseSchema(doc: GqlDocument): void {
    this.#expectPunct('{');
    while (!this.#acceptPunct('}')) {
      const operation = this.#expectName(); // query / mutation / subscription
      this.#expectPunct(':');
      const type = this.#expectName();
      if (operation === 'query' || operation === 'mutation' || operation === 'subscription') {
        doc.roots[operation] = type;
      }
    }
  }

  #parseType(doc: GqlDocument, description: string | undefined, isInput: boolean): void {
    const name = this.#expectName();
    const interfaces: string[] = [];

    if (this.#peek().kind === 'name' && this.#peek().value === 'implements') {
      this.#next();
      interfaces.push(this.#expectName());
      while (this.#acceptPunct('&')) interfaces.push(this.#expectName());
    }

    const existing = doc.types.get(name);
    const fields: GqlField[] = existing?.fields ?? [];

    this.#expectPunct('{');
    while (!this.#acceptPunct('}')) {
      const fieldDescription = this.#takeDescription();
      const fieldName = this.#expectName();

      const args: GqlArg[] = [];
      if (this.#acceptPunct('(')) {
        while (!this.#acceptPunct(')')) {
          const argDescription = this.#takeDescription();
          const argName = this.#expectName();
          this.#expectPunct(':');
          const type = this.#parseTypeRef();
          let defaultValue: string | undefined;
          if (this.#acceptPunct('=')) defaultValue = this.#parseValue();
          args.push({ name: argName, type, description: argDescription, defaultValue });
        }
      }

      this.#expectPunct(':');
      const type = this.#parseTypeRef();

      let deprecated = false;
      while (this.#acceptPunct('@')) {
        const directive = this.#expectName();
        if (directive === 'deprecated') deprecated = true;
        if (this.#acceptPunct('(')) this.#skipBalanced('(', ')');
      }

      fields.push({
        name: fieldName,
        type,
        args,
        description: fieldDescription,
        deprecated,
      });
    }

    doc.types.set(name, {
      name,
      kind: isInput ? 'input' : 'type',
      description,
      fields,
      interfaces,
    });
  }

  #parseExtend(doc: GqlDocument): void {
    const keyword = this.#expectName();
    if (keyword !== 'type') {
      throw new GraphQLParseError(`Only "extend type" is supported, got ${JSON.stringify(keyword)}`, this.#peek().line);
    }
    this.#parseType(doc, undefined, false);
  }

  #parseInterface(doc: GqlDocument, description: string | undefined): void {
    const name = this.#expectName();
    this.#expectPunct('{');
    const fields: GqlField[] = [];
    while (!this.#acceptPunct('}')) {
      const fieldDescription = this.#takeDescription();
      const fieldName = this.#expectName();
      this.#expectPunct(':');
      const type = this.#parseTypeRef();
      fields.push({ name: fieldName, type, args: [], description: fieldDescription });
    }
    doc.types.set(name, { name, kind: 'interface', description, fields, interfaces: [] });
  }

  #parseEnum(doc: GqlDocument, description: string | undefined): void {
    const name = this.#expectName();
    this.#expectPunct('{');
    const values: string[] = [];
    while (!this.#acceptPunct('}')) {
      this.#takeDescription();
      const value = this.#expectName();
      while (this.#acceptPunct('@')) {
        this.#expectName();
        if (this.#acceptPunct('(')) this.#skipBalanced('(', ')');
      }
      values.push(value);
    }
    doc.enums.set(name, values);
    void description;
  }

  #parseUnion(doc: GqlDocument, description: string | undefined): void {
    const name = this.#expectName();
    this.#expectPunct('=');
    const members: string[] = [this.#expectName()];
    while (this.#acceptPunct('|')) members.push(this.#expectName());
    doc.unions.set(name, members);
    void description;
  }

  #parseScalar(doc: GqlDocument, description: string | undefined): void {
    const name = this.#expectName();
    while (this.#acceptPunct('@')) {
      this.#expectName();
      if (this.#acceptPunct('(')) this.#skipBalanced('(', ')');
    }
    doc.scalars.add(name);
    void description;
  }

  #skipDirectiveDefinition(): void {
    // directive @name(args) on LOCATIONS — skipped wholesale.
    this.#expectPunct('@');
    this.#expectName();
    if (this.#acceptPunct('(')) this.#skipBalanced('(', ')');
    while (this.#peek().kind === 'name') {
      this.#next();
      if (this.#acceptPunct('|')) continue;
      break;
    }
  }

  #parseTypeRef(): GqlTypeRef {
    let ref: GqlTypeRef;
    if (this.#acceptPunct('[')) {
      const inner = this.#parseTypeRef();
      this.#expectPunct(']');
      ref = { kind: 'list', of: inner, nonNull: false };
    } else {
      ref = { kind: 'named', name: this.#expectName(), nonNull: false };
    }
    if (this.#acceptPunct('!')) ref = { ...ref, nonNull: true };
    return ref;
  }

  #parseValue(): string {
    const token = this.#next();
    if (token.kind === 'name' || token.kind === 'string' || token.kind === 'blockString') {
      return token.value;
    }
    if (token.kind === 'punct' && (token.value === '[' || token.value === '{')) {
      const open = token.value;
      const close = open === '[' ? ']' : '}';
      this.#skipBalanced(open, close);
      return open === '[' ? '[]' : '{}';
    }
    throw new GraphQLParseError(`Expected a value, got ${describe(token)}`, token.line);
  }

  #skipBalanced(open: string, close: string): void {
    let depth = 1;
    while (depth > 0) {
      const token = this.#next();
      if (token.kind === 'eof') {
        throw new GraphQLParseError(`Unterminated ${JSON.stringify(open)}`, token.line);
      }
      if (token.kind === 'punct' && token.value === open) depth++;
      if (token.kind === 'punct' && token.value === close) depth--;
    }
  }
}

function describe(token: Token): string {
  if (token.kind === 'eof') return 'end of document';
  return JSON.stringify(token.value);
}

function resolveRoots(doc: GqlDocument): void {
  const queryRoot = doc.roots.query ?? (doc.types.has('Query') ? 'Query' : undefined);
  const mutationRoot = doc.roots.mutation ?? (doc.types.has('Mutation') ? 'Mutation' : undefined);
  const subscriptionRoot =
    doc.roots.subscription ?? (doc.types.has('Subscription') ? 'Subscription' : undefined);

  doc.roots = { query: queryRoot, mutation: mutationRoot, subscription: subscriptionRoot };
  doc.queries = queryRoot ? (doc.types.get(queryRoot)?.fields ?? []) : [];
  doc.mutations = mutationRoot ? (doc.types.get(mutationRoot)?.fields ?? []) : [];
  doc.subscriptions = subscriptionRoot ? (doc.types.get(subscriptionRoot)?.fields ?? []) : [];
}

/** Parses a GraphQL SDL document. */
export function parseGraphQLSdl(source: string): GqlDocument {
  return new Parser(source).parseDocument();
}
