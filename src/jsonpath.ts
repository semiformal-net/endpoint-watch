import { parse, query } from 'jsonpathly';

export function validateJsonPath(path: string): void {
  try {
    parse(path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSONPath "${path}": ${detail}`);
  }
}

export function extractJsonPath(data: unknown, path: string): unknown {
  const results = query(data, path, { returnArray: true }) as unknown[];

  if (results.length === 0) {
    return null;
  }

  if (results.length === 1) {
    return results[0] ?? null;
  }

  return results.map((value) => value ?? null);
}
