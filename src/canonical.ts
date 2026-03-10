function normalize(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => normalize(item));
  }
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = normalize(record[key]);
    }
    return out;
  }
  return input;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function canonicalize(value: unknown): unknown {
  return normalize(value);
}

export function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function hashCanonical(value: unknown): Promise<string> {
  const payload = new TextEncoder().encode(canonicalString(value));
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return toHex(new Uint8Array(digest));
}

export async function makeEventId(
  watchName: string,
  oldHash: string | undefined,
  newHash: string,
): Promise<string> {
  const raw = `${watchName}:${oldHash ?? 'none'}:${newHash}`;
  const payload = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return toHex(new Uint8Array(digest));
}
