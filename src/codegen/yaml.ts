/**
 * A dependency-free YAML subset parser, good enough for OpenAPI documents.
 *
 * Supported constructs (everything a typical spec uses):
 * - block mappings and sequences, including compact `- key: value` items
 * - single/double-quoted scalars with escapes
 * - plain scalars with multi-line continuation, typed (null / bool / int /
 *   float / string)
 * - inline flow collections `[a, b]` and `{a: 1}` (single line)
 * - block scalars `|`, `>`, with `-`/`+` chomping indicators
 * - comments and blank lines
 * - multiple documents (the first one is parsed)
 *
 * Not supported (a clear error is raised): anchors/aliases (`&a`, `*a`) and
 * merge keys (`<<:`) — convert the spec to JSON if it relies on them.
 */

export interface YamlLine {
  indent: number;
  text: string;
  blank: boolean;
  comment: boolean;
  number: number;
}

export class YamlParseError extends Error {
  constructor(message: string, readonly lineNumber?: number) {
    super(lineNumber ? `${message} (line ${lineNumber})` : message);
    this.name = 'YamlParseError';
  }
}

export function parseYaml(source: string): unknown {
  return new YamlParser(prepareLines(source)).parseDocument();
}

function prepareLines(source: string): YamlLine[] {
  const lines: YamlLine[] = [];
  const rawLines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const indentMatch = /^[\t ]*/.exec(raw)![0]!;
    if (indentMatch.includes('\t')) {
      throw new YamlParseError('Tab characters are not allowed in indentation', i + 1);
    }
    const indent = indentMatch.length;
    const text = raw.slice(indent).trimEnd();
    const blank = text === '';
    const comment = !blank && text.startsWith('#');
    lines.push({ indent, text, blank, comment, number: i + 1 });
  }
  return lines;
}

const BLOCK_SCALAR_RE = /^([|>])([+-]?)$/;

class YamlParser {
  private pos = 0;

  constructor(private readonly lines: YamlLine[]) {}

  parseDocument(): unknown {
    this.skipDocumentStart();
    if (this.peekMeaningful() === undefined) return null;
    const value = this.parseBlock(0);
    const leftover = this.peekMeaningful();
    if (leftover) {
      throw new YamlParseError(
        `Unexpected content after the document: ${JSON.stringify(leftover.text)}`,
        leftover.number,
      );
    }
    return value;
  }

  private skipDocumentStart(): void {
    const line = this.peekMeaningful();
    if (line && line.indent === 0 && line.text === '---') {
      this.consumeUpTo(line);
    }
  }

  private peekMeaningful(): YamlLine | undefined {
    for (let i = this.pos; i < this.lines.length; i++) {
      const line = this.lines[i]!;
      if (!line.blank && !line.comment) return line;
    }
    return undefined;
  }

  private consumeUpTo(target: YamlLine): void {
    while (this.pos < this.lines.length && this.lines[this.pos] !== target) this.pos++;
    if (this.pos < this.lines.length) this.pos++;
  }

  private nextMeaningful(): YamlLine {
    const line = this.peekMeaningful();
    if (!line) throw new YamlParseError('Unexpected end of document');
    this.consumeUpTo(line);
    return line;
  }

  private parseBlock(minIndent: number): unknown {
    const line = this.peekMeaningful();
    if (!line || line.indent < minIndent) return null;
    if (line.text === '-' || line.text.startsWith('- ')) {
      return this.parseSequence(line.indent);
    }
    if (isMappingEntry(line.text)) {
      return this.parseMapping(line.indent);
    }
    // A bare scalar: either the whole document or the value under a key.
    this.consumeUpTo(line);
    return this.parseInlineValue(stripTrailingComment(line.text), line.indent);
  }

  private parseSequence(indent: number): unknown[] {
    const items: unknown[] = [];
    for (;;) {
      const line = this.peekMeaningful();
      if (!line || line.indent !== indent) break;
      if (!(line.text === '-' || line.text.startsWith('- '))) break;

      this.consumeUpTo(line);
      if (line.text === '-') {
        items.push(this.parseBlock(indent + 1));
        continue;
      }

      const after = line.text.slice(1);
      const padMatch = /^(\s*)(.*)$/.exec(after)!;
      const rest = padMatch![2]!;
      const contentIndent = indent + 1 + padMatch![1]!.length;

      if (rest === '') {
        items.push(this.parseBlock(contentIndent));
        continue;
      }

      // Compact nested structure: `- key: value` or `- - x`
      if (isMappingEntry(rest) || rest === '-' || rest.startsWith('- ')) {
        this.lines.splice(this.pos, 0, {
          indent: contentIndent,
          text: rest,
          blank: false,
          comment: false,
          number: line.number,
        });
        items.push(this.parseBlock(contentIndent));
      } else {
        items.push(this.parseInlineValue(stripTrailingComment(rest), indent));
      }
    }
    return items;
  }

  private parseMapping(indent: number): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    for (;;) {
      const line = this.peekMeaningful();
      if (!line || line.indent !== indent) break;
      if (line.text === '-' || line.text.startsWith('- ')) break;
      if (line.indent < indent) break;

      this.consumeUpTo(line);
      const split = splitMappingEntry(line);
      if (!split) {
        throw new YamlParseError(
          `Expected a "key: value" mapping entry, got ${JSON.stringify(line.text)}`,
          line.number,
        );
      }
      const key = unquoteScalar(split.key);
      const rest = split.value.trim();

      if (rest === '' || rest.startsWith('#')) {
        const next = this.peekMeaningful();
        map[key] = next && next.indent > indent ? this.parseBlock(indent + 1) : null;
      } else if (BLOCK_SCALAR_RE.test(rest)) {
        map[key] = this.parseBlockScalar(BLOCK_SCALAR_RE.exec(rest)!, indent, line.number);
      } else {
        map[key] = this.parseInlineValue(rest, indent);
      }
    }
    return map;
  }

  private parseInlineValue(rest: string, indent: number): unknown {
    if (rest.startsWith('[') || rest.startsWith('{')) {
      const flow = parseFlow(rest, this.lines[this.pos - 1]?.number);
      // Allow deeper continuation lines to be swallowed harmlessly (flow
      // collections are single-line in this subset).
      return flow;
    }
    if (rest.startsWith("'") || rest.startsWith('"')) {
      return unquoteScalar(rest);
    }
    if (rest.startsWith('&') || rest.startsWith('*') || rest.startsWith('!')) {
      const n = this.lines[this.pos - 1]?.number;
      throw new YamlParseError(
        'Anchors, aliases and explicit tags are not supported; convert the spec to JSON',
        n,
      );
    }
    // Plain scalar with optional continuation lines.
    let text = rest;
    for (;;) {
      const line = this.peekMeaningful();
      if (!line || line.indent <= indent) break;
      this.consumeUpTo(line);
      text += ` ${stripTrailingComment(line.text)}`;
    }
    return parsePlainScalar(text);
  }

  private parseBlockScalar(
    indicator: RegExpExecArray,
    keyIndent: number,
    keyLine: number,
  ): string {
    const style = indicator[1]!; // '|' or '>'
    const chomp = indicator[2] ?? ''; // '', '-', '+'

    const raw: { text: string; indent: number; blank: boolean }[] = [];
    for (;;) {
      if (this.pos >= this.lines.length) break;
      const line = this.lines[this.pos]!;
      if (line.blank) {
        raw.push({ text: '', indent: line.indent, blank: true });
        this.pos++;
        continue;
      }
      if (line.comment && line.indent > keyIndent) {
        // '#' lines inside a block scalar are literal content.
        raw.push({ text: line.text, indent: line.indent, blank: false });
        this.pos++;
        continue;
      }
      if (line.indent <= keyIndent) break;
      raw.push({ text: line.text, indent: line.indent, blank: false });
      this.pos++;
    }

    // Trailing blank lines belong to the following structure, not the scalar.
    while (raw.length > 0 && raw[raw.length - 1]!.blank) raw.pop();

    const meaningful = raw.find((l) => !l.blank);
    if (!meaningful) return chomp === '-' ? '' : '';

    const blockIndent = meaningful.indent;
    const contentLines = raw.map((l) =>
      l.blank ? '' : ' '.repeat(Math.max(0, l.indent - blockIndent)) + l.text,
    );

    let body: string;
    if (style === '|') {
      body = contentLines.join('\n');
    } else {
      // Folded: single newlines become spaces; blank lines become newlines.
      const folded: string[] = [];
      for (const l of contentLines) {
        if (l === '') folded.push('\n');
        else if (folded.length > 0 && folded[folded.length - 1] !== '\n') folded.push(' ', l);
        else folded.push(l);
      }
      body = folded.join('').replace(/\n /g, '\n').replace(/ \n/g, '\n');
    }

    if (chomp === '-') return body;
    return `${body}\n`;
  }
}

/* -------------------------------------------------------------------------- */
/* Scalar helpers                                                              */
/* -------------------------------------------------------------------------- */

function isMappingEntry(text: string): boolean {
  return splitMappingEntryText(text) !== null;
}

function splitMappingEntryText(text: string): { key: string; value: string } | null {
  let i = 0;
  let quote: '"' | "'" | null = null;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ':') {
      const next = text[i + 1];
      if (next === undefined || next === ' ') {
        return { key: text.slice(0, i).trim(), value: text.slice(i + 1).trim() };
      }
    } else if (ch === '#' && i > 0 && text[i - 1] === ' ') {
      return null; // comment before any colon
    } else if ((ch === '[' || ch === '{') && i === 0) {
      return null; // line starts with a flow collection — not a mapping entry
    }
    i++;
  }
  return null;
}

function splitMappingEntry(line: YamlLine): { key: string; value: string } | null {
  return splitMappingEntryText(line.text);
}

/** Removes a trailing ` # comment` that is outside quotes. */
function stripTrailingComment(text: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || text[i - 1] === ' ')) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text;
}

function parsePlainScalar(text: string): unknown {
  const t = text.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (/^[+-]?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^0x[0-9a-fA-F]+$/.test(t)) return Number.parseInt(t, 16);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t) && /[.eE]/.test(t)) {
    return Number.parseFloat(t);
  }
  return t;
}

/** Parses a quoted scalar (`'...'` or `"..."`) including closing quote. */
function unquoteScalar(text: string): string {
  const t = text.trim();
  if (t.startsWith("'")) {
    const end = findClosing(t, "'", 1);
    if (end === -1) throw new YamlParseError(`Unterminated single-quoted scalar: ${t}`);
    return t.slice(1, end).replace(/''/g, "'");
  }
  if (t.startsWith('"')) {
    const end = findClosing(t, '"', 1);
    if (end === -1) throw new YamlParseError(`Unterminated double-quoted scalar: ${t}`);
    return unescapeDouble(t.slice(1, end));
  }
  return t;
}

function findClosing(text: string, quote: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') {
      i++;
      continue;
    }
    if (quote === "'" && text[i] === "'" && text[i + 1] === "'") {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

function unescapeDouble(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, g: string) => {
    if (g[0] === 'u' && g.length === 5) {
      return String.fromCharCode(Number.parseInt(g.slice(1), 16));
    }
    switch (g) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case 'b': return '\b';
      case 'f': return '\f';
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      default: return g;
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Flow collections (single line)                                              */
/* -------------------------------------------------------------------------- */

class FlowParser {
  private i = 0;

  constructor(
    private readonly text: string,
    private readonly lineNumber?: number,
  ) {}

  parse(): unknown {
    const value = this.parseValue();
    this.skipWs();
    if (this.i < this.text.length) {
      throw new YamlParseError(
        `Trailing characters after flow collection: ${JSON.stringify(this.text.slice(this.i))}`,
        this.lineNumber,
      );
    }
    return value;
  }

  private skipWs(): void {
    while (this.i < this.text.length && /\s/.test(this.text[this.i]!)) this.i++;
  }

  private parseValue(): unknown {
    this.skipWs();
    const ch = this.text[this.i]!;
    if (ch === '[') return this.parseArray();
    if (ch === '{') return this.parseMap();
    if (ch === '"' || ch === "'") return this.parseQuoted();
    return this.parsePlain();
  }

  private parseArray(): unknown[] {
    this.i++; // [
    const items: unknown[] = [];
    this.skipWs();
    if (this.text[this.i] === ']') {
      this.i++;
      return items;
    }
    for (;;) {
      items.push(this.parseValue());
      this.skipWs();
      const ch = this.text[this.i]!;
      if (ch === ',') {
        this.i++;
        this.skipWs();
        if (this.text[this.i] === ']') {
          this.i++;
          return items;
        }
        continue;
      }
      if (ch === ']') {
        this.i++;
        return items;
      }
      throw new YamlParseError(`Malformed flow array near ${this.context()}`, this.lineNumber);
    }
  }

  private parseMap(): Record<string, unknown> {
    this.i++; // {
    const map: Record<string, unknown> = {};
    this.skipWs();
    if (this.text[this.i] === '}') {
      this.i++;
      return map;
    }
    for (;;) {
      this.skipWs();
      let key: string;
      const ch = this.text[this.i]!;
      if (ch === '"' || ch === "'") {
        key = this.parseQuoted() as string;
      } else {
        const start = this.i;
        while (this.i < this.text.length && !':,}'.includes(this.text[this.i]!)) this.i++;
        key = this.text.slice(start, this.i).trim();
      }
      this.skipWs();
      if (this.text[this.i] !== ':') {
        throw new YamlParseError(`Expected ':' in flow mapping near ${this.context()}`, this.lineNumber);
      }
      this.i++;
      map[unquoteScalar(key)] = this.parseValue();
      this.skipWs();
      const next = this.text[this.i]!;
      if (next === ',') {
        this.i++;
        this.skipWs();
        if (this.text[this.i] === '}') {
          this.i++;
          return map;
        }
        continue;
      }
      if (next === '}') {
        this.i++;
        return map;
      }
      throw new YamlParseError(`Malformed flow mapping near ${this.context()}`, this.lineNumber);
    }
  }

  private parseQuoted(): string {
    const quote = this.text[this.i]!;
    const start = this.i;
    this.i++;
    while (this.i < this.text.length) {
      if (quote === '"' && this.text[this.i] === '\\') {
        this.i += 2;
        continue;
      }
      if (this.text[this.i] === quote) {
        this.i++;
        return unquoteScalar(this.text.slice(start, this.i));
      }
      this.i++;
    }
    throw new YamlParseError(`Unterminated quoted scalar in flow collection`, this.lineNumber);
  }

  private parsePlain(): unknown {
    const start = this.i;
    while (this.i < this.text.length && !',]}'.includes(this.text[this.i]!)) this.i++;
    const raw = this.text.slice(start, this.i).trim();
    return parsePlainScalar(stripTrailingComment(raw));
  }

  private context(): string {
    return JSON.stringify(this.text.slice(Math.max(0, this.i - 12), this.i + 12));
  }
}

function parseFlow(text: string, lineNumber?: number): unknown {
  return new FlowParser(text, lineNumber).parse();
}
