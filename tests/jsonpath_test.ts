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

Deno.test('jsonpath filter matches by equality', () => {
  const data = {
    releases: [
      { cycle: '1.29', latest: '1.29.4' },
      { cycle: '1.30', latest: '1.30.2' },
      { cycle: '1.31', latest: '1.31.0' },
    ],
  };
  assertEquals(
    extractJsonPath(data, "$.releases[?(@.cycle == '1.30')].latest"),
    '1.30.2',
  );
});

Deno.test('jsonpath filter with no match returns null', () => {
  const data = {
    releases: [
      { cycle: '1.29', latest: '1.29.4' },
    ],
  };
  assertEquals(
    extractJsonPath(data, "$.releases[?(@.cycle == '9.99')].latest"),
    null,
  );
});

Deno.test('jsonpath filter with multiple matches returns array', () => {
  const data = {
    releases: [
      { cycle: '1.29', lts: true, latest: '1.29.4' },
      { cycle: '1.30', lts: false, latest: '1.30.2' },
      { cycle: '1.31', lts: true, latest: '1.31.0' },
    ],
  };
  assertEquals(
    extractJsonPath(data, '$.releases[?(@.lts == true)].latest'),
    ['1.29.4', '1.31.0'],
  );
});

Deno.test('jsonpath filter with logical AND', () => {
  const data = {
    releases: [
      { cycle: '1.29', lts: true, eol: false, latest: '1.29.4' },
      { cycle: '1.30', lts: true, eol: true, latest: '1.30.2' },
      { cycle: '1.31', lts: false, eol: false, latest: '1.31.0' },
    ],
  };
  assertEquals(
    extractJsonPath(data, '$.releases[?(@.lts == true && @.eol == false)].latest'),
    '1.29.4',
  );
});

Deno.test('jsonpath recursive descent collects matches', () => {
  const data = {
    a: { name: 'x' },
    b: { nested: { name: 'y' } },
  };
  assertEquals(extractJsonPath(data, '$..name'), ['x', 'y']);
});
