import { assertEquals, assertThrows } from '@std/assert';
import { extractJsonPath, validateJsonPath } from '../src/jsonpath.ts';

Deno.test('jsonpath extracts top-level field', () => {
  const data = { tag_name: 'v1.2.3' };
  assertEquals(extractJsonPath(data, '$.tag_name'), 'v1.2.3');
});

Deno.test('jsonpath returns null on missing segment', () => {
  const data = { tag_name: 'v1.2.3' };
  assertEquals(extractJsonPath(data, '$.missing.value'), null);
});

Deno.test('jsonpath supports array index and quoted field', () => {
  const data = { releases: [{ 'tag-name': 'v9.9.9' }] };
  assertEquals(extractJsonPath(data, '$.releases[0]["tag-name"]'), 'v9.9.9');
});

Deno.test('jsonpath supports wildcard list extraction', () => {
  const data = {
    jobs: [{ title: 'Backend Engineer' }, { title: 'Data Engineer' }],
  };
  assertEquals(extractJsonPath(data, '$.jobs[*].title'), ['Backend Engineer', 'Data Engineer']);
});

Deno.test('jsonpath wildcard returns scalar when one match', () => {
  const data = {
    jobs: [{ title: 'Only Role' }],
  };
  assertEquals(extractJsonPath(data, '$.jobs[*].title'), 'Only Role');
});

Deno.test('jsonpath wildcard returns null when no matches', () => {
  const data = { jobs: [] };
  assertEquals(extractJsonPath(data, '$.jobs[*].title'), null);
});

Deno.test('jsonpath returns null for out-of-range array index', () => {
  const data = { items: ['a'] };
  assertEquals(extractJsonPath(data, '$.items[9]'), null);
});

Deno.test('jsonpath validation catches bad syntax', () => {
  assertThrows(() => validateJsonPath('tag_name'));
  assertThrows(() => validateJsonPath('$.foo[]'));
});
