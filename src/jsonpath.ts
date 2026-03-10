const WILDCARD = Symbol('wildcard');
type PathToken = string | number | typeof WILDCARD;

function parsePath(path: string): PathToken[] {
  if (!path.startsWith('$')) {
    throw new Error(`Invalid JSONPath "${path}": must start with $`);
  }
  const tokens: PathToken[] = [];
  let i = 1;

  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      i += 1;
      const start = i;
      while (i < path.length && /[A-Za-z0-9_\-$]/.test(path[i])) {
        i += 1;
      }
      if (start === i) {
        throw new Error(`Invalid JSONPath "${path}": empty property segment`);
      }
      tokens.push(path.slice(start, i));
      continue;
    }

    if (ch === '[') {
      i += 1;
      const close = path.indexOf(']', i);
      if (close === -1) {
        throw new Error(`Invalid JSONPath "${path}": missing ]`);
      }
      const inner = path.slice(i, close).trim();
      if (!inner) {
        throw new Error(`Invalid JSONPath "${path}": empty []`);
      }
      if (inner === '*') {
        tokens.push(WILDCARD);
      } else if (/^\d+$/.test(inner)) {
        tokens.push(Number(inner));
      } else if (
        (inner.startsWith('"') && inner.endsWith('"')) ||
        (inner.startsWith("'") && inner.endsWith("'"))
      ) {
        tokens.push(inner.slice(1, -1));
      } else {
        throw new Error(
          `Invalid JSONPath "${path}": [] must contain numeric index or quoted property`,
        );
      }
      i = close + 1;
      continue;
    }

    throw new Error(`Invalid JSONPath "${path}": unexpected character "${ch}"`);
  }

  return tokens;
}

export function validateJsonPath(path: string): void {
  parsePath(path);
}

export function extractJsonPath(data: unknown, path: string): unknown {
  const tokens = parsePath(path);
  let frontier: unknown[] = [data];

  for (const token of tokens) {
    const next: unknown[] = [];
    for (const current of frontier) {
      if (current === null || current === undefined) {
        continue;
      }
      if (token === WILDCARD) {
        if (Array.isArray(current)) {
          next.push(...current);
        }
        continue;
      }
      if (typeof token === 'number') {
        if (Array.isArray(current) && token < current.length) {
          next.push(current[token]);
        }
        continue;
      }
      if (typeof current === 'object' && !Array.isArray(current)) {
        const record = current as Record<string, unknown>;
        if (token in record) {
          next.push(record[token]);
        }
      }
    }
    frontier = next;
  }

  if (frontier.length === 0) {
    return null;
  }

  if (frontier.length === 1) {
    return frontier[0] ?? null;
  }

  return frontier.map((value) => value ?? null);
}
