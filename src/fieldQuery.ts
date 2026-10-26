/**
 * The field query of MoleSignal's Logs page, read the same way here:
 * `level = 'error' AND (service = 'checkout' OR timeout)`. `AND` binds tighter
 * than `OR`, brackets group, the words in any case; a comparison
 * (`=`, `!=`, `>`, `>=`, `<`, `<=`, `contains`), a search function
 * (`MATCH(field, 'text')`, `MATCH_TEXT(field, 'words')`), or text to find in
 * `message`, a quoted phrase as one. Kept in step with
 * `web/src/shell/query/fieldExpression.ts` and `web/src/routes/logs/fieldQueryModel.ts`.
 */

type Expression = { kind: 'and' | 'or'; items: Expression[]; text: string } | { kind: 'part'; text: string };

type Keyword = 'AND' | 'OR';

/** Whether `keyword` stands at `index` as a word of its own: spaces or brackets around it. */
function startsKeyword(text: string, index: number, keyword: Keyword): boolean {
  if (text.slice(index, index + keyword.length).toUpperCase() !== keyword) return false;
  const before = index === 0 ? ' ' : text[index - 1]!;
  const after = index + keyword.length === text.length ? ' ' : text[index + keyword.length]!;
  return /[\s)]/.test(before) && /[\s(]/.test(after);
}

/** The pieces of `text` between the keyword where it stands outside quotes and brackets. */
function splitAt(text: string, keyword: Keyword): string[] {
  const pieces: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0 || !startsKeyword(text, index, keyword)) continue;

    pieces.push(text.slice(start, index));
    index += keyword.length - 1;
    start = index + 1;
  }

  pieces.push(text.slice(start));
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

/** The inside of a part that is one group in brackets, `(a OR b)`; `null` for any other part. */
function bracketed(part: string): string | null {
  if (!part.startsWith('(') || !part.endsWith(')')) return null;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < part.length; index += 1) {
    const character = part[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character !== ')') continue;
    depth -= 1;
    // The first bracket closes before the end: `(a) OR (b)` is two groups.
    if (depth === 0) return index === part.length - 1 ? part.slice(1, -1) : null;
  }
  return null;
}

function group(kind: 'and' | 'or', items: Expression[], text: string): Expression {
  if (items.length === 1) return items[0]!;
  return { kind, items: items.flatMap((item) => (item.kind === kind ? item.items : [item])), text };
}

function readPart(part: string): Expression {
  const inside = bracketed(part);
  if (inside === null) return { kind: 'part', text: part };
  const read = readExpression(inside);
  if (read === null) return { kind: 'part', text: part };
  return read.kind === 'part' ? read : { ...read, text: part };
}

function readExpression(text: string): Expression | null {
  const alternatives = splitAt(text, 'OR').map((alternative) => {
    const parts = splitAt(alternative, 'AND').map(readPart);
    return parts.length === 0 ? null : group('and', parts, alternative);
  });
  const read = alternatives.filter((item): item is Expression => item !== null);
  return read.length === 0 ? null : group('or', read, text.trim());
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t' };

/** What a part that is one quoted string says; `null` for a part that is not one. */
function quotedText(part: string): string | null {
  const quote = part[0];
  if ((quote !== "'" && quote !== '"') || part.length < 2) return null;
  let value = '';
  for (let index = 1; index < part.length; index += 1) {
    const character = part[index]!;
    if (character === '\\' && index < part.length - 1) {
      const next = part[index + 1]!;
      value += ESCAPES[next] ?? next;
      index += 1;
      continue;
    }
    if (character === quote) return index === part.length - 1 ? value : null;
    value += character;
  }
  return null;
}

/** A value with its quotes taken off and its escapes read. */
function unquote(raw: string): { value: string; quoted: boolean } {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      const inner = trimmed.slice(1, -1);
      const replacements: Record<string, string> = { '\\': '\\', "'": "'", '"': '"', n: '\n', r: '\r', t: '\t' };
      return { value: inner.replace(/\\([\\'"nrt])/g, (_, escaped: string) => replacements[escaped]!), quoted: true };
    }
  }
  return { value: trimmed, quoted: false };
}

const sqlString = (value: string) => value.replaceAll("'", "''");
const sqlIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

interface Clause {
  field: string;
  op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'match' | 'match_text';
  value: string;
  quoted: boolean;
}

type Part = { kind: 'filter'; clause: Clause } | { kind: 'text'; value: string } | { kind: 'rejected' };

/** One part of a field query: a search function, a comparison, or text to find. */
function readFieldPart(part: string): Part {
  const functionMatch = part.match(/^(MATCH_TEXT|MATCH)\s*\(\s*([a-zA-Z_][\w.]*)\s*,\s*([\s\S]*?)\s*\)$/i);
  if (functionMatch) {
    const { value, quoted } = unquote(functionMatch[3]!);
    if (!quoted) return { kind: 'rejected' };
    const op = functionMatch[1]!.toLowerCase() as 'match' | 'match_text';
    return { kind: 'filter', clause: { field: functionMatch[2]!, op, value, quoted: true } };
  }
  if (/^(MATCH_TEXT|MATCH)\b/i.test(part) || part.startsWith('(')) return { kind: 'rejected' };

  const match = part.match(/^([a-zA-Z_][\w.]*)\s*(>=|<=|!=|=|>|<|eq\b|ne\b|contains\b|like\b)\s*([\s\S]+)$/i);
  if (!match) {
    const phrase = quotedText(part);
    if (phrase === null) return { kind: 'text', value: part };
    return phrase.trim() ? { kind: 'text', value: phrase } : { kind: 'rejected' };
  }

  const raw = match[2]!.toLowerCase();
  const op: Clause['op'] =
    raw === 'eq' ? '=' : raw === 'ne' ? '!=' : raw === 'like' ? 'contains' : (raw as Clause['op']);
  const { value, quoted } = unquote(match[3]!);
  const presence = quoted && value === '' && (op === '=' || op === '!=');
  if (!value && !presence) return { kind: 'rejected' };
  return { kind: 'filter', clause: { field: match[1]!, op, value, quoted } };
}

const collapsedSpace = (field: string) => `regexp_replace(CAST(${field} AS VARCHAR), '[[:space:]]+', ' ', 'g')`;

/** One comparison as SQL, the way the Logs page writes it. */
function clauseSql(clause: Clause): string {
  const field = sqlIdentifier(clause.field);

  if (clause.op === 'match' || clause.op === 'match_text') {
    if (clause.op === 'match' && clause.value.length === 0) return 'FALSE';
    const name = clause.op === 'match' ? 'MATCH' : 'MATCH_TEXT';
    const target = /^[a-zA-Z_]\w*$/.test(clause.field) ? clause.field : field;
    return `${name}(${target}, '${sqlString(clause.value)}')`;
  }

  // `field = ''` is the records without a value, `field != ''` those with one, whatever the field's type.
  if (clause.quoted && clause.value === '' && (clause.op === '=' || clause.op === '!=')) {
    return clause.op === '=' ? `(${field} IS NULL OR CAST(${field} AS VARCHAR) = '')` : `CAST(${field} AS VARCHAR) != ''`;
  }

  // A quoted value with spaces also matches text whose line breaks and runs of spaces show as one.
  const spaced = clause.quoted && /\s/.test(clause.value);
  const collapsed = clause.value.replace(/\s+/g, ' ');

  if (clause.op === 'contains') {
    const direct = `CAST(${field} AS VARCHAR) LIKE '%${sqlString(clause.value)}%'`;
    return spaced ? `(${direct} OR ${collapsedSpace(field)} LIKE '%${sqlString(collapsed)}%')` : direct;
  }

  const literal =
    !clause.quoted && /^-?\d+(?:\.\d+)?$/.test(clause.value)
      ? clause.value
      : !clause.quoted && /^(true|false)$/i.test(clause.value)
        ? clause.value.toUpperCase()
        : `'${sqlString(clause.value)}'`;
  const direct = `${field} ${clause.op} ${literal}`;
  if (!spaced) return direct;
  const normalized = `${collapsedSpace(field)} ${clause.op} '${sqlString(collapsed)}'`;
  return clause.op === '=' ? `(${direct} OR ${normalized})` : `(${direct} AND ${normalized})`;
}

/** A part of a field query as SQL; `null` where it holds something the query cannot read. */
function expressionSql(expression: Expression): string | null {
  if (expression.kind === 'part') {
    const read = readFieldPart(expression.text);
    if (read.kind === 'filter') return clauseSql(read.clause);
    if (read.kind === 'text') return `"message" LIKE '%${sqlString(read.value)}%'`;
    return null;
  }
  const items = expression.items.map(expressionSql);
  if (items.some((item) => item === null)) return null;
  return `(${items.join(expression.kind === 'and' ? ' AND ' : ' OR ')})`;
}

/**
 * A field query as one SQL condition, or nothing for an empty query. A part
 * the query cannot read is an error that names it, rather than left out.
 */
export function fieldQuerySql(statement: string): string | undefined {
  const read = readExpression(statement);
  if (read === null) return undefined;
  const parts = read.kind === 'and' ? read.items : [read];
  const conditions = parts.map((part) => {
    const sql = expressionSql(part);
    if (sql === null) throw new Error(`Cannot read "${part.text}" in the query; quote the value, as in level = 'error'`);
    return sql;
  });
  return conditions.join(' AND ');
}
