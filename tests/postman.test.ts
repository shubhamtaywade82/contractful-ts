import { describe, expect, it } from 'vitest';
import { buildPostmanIR, inferSchemaFromValue } from '../src/codegen/postman.js';
import { emitContracts } from '../src/codegen/emitter.js';
import type { JsonRecord } from '../src/codegen/openapi.js';

const COLLECTION: JsonRecord = {
  info: {
    name: 'Todo API',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [{ key: 'baseUrl', value: 'https://api.todo.test/v1' }],
  auth: { type: 'bearer' },
  item: [
    {
      name: 'Tasks',
      item: [
        {
          name: 'List tasks',
          request: {
            method: 'GET',
            url: {
              raw: '{{baseUrl}}/tasks?completed=true',
              host: ['{{baseUrl}}'],
              path: ['tasks'],
              query: [
                { key: 'completed', value: 'true', description: 'Filter by completion' },
                { key: 'limit', value: '25', disabled: true },
              ],
            },
            header: [{ key: 'X-Request-Id', value: 'abc-123' }],
          },
          response: [
            {
              name: 'ok',
              code: 200,
              body: '[{ "id": "t1", "done": true }]',
            },
          ],
        },
        {
          name: 'Create task',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            url: { raw: '{{baseUrl}}/tasks', host: ['{{baseUrl}}'], path: ['tasks'] },
            body: {
              mode: 'raw',
              raw: '{\n  "title": "Buy milk",\n  "priority": 2,\n  "tags": ["home"],\n  "done": false\n}',
              options: { raw: { language: 'json' } },
            },
          },
          response: [
            { name: 'created', code: 201, body: '{ "id": "t9", "title": "Buy milk" }' },
            { name: 'created', code: 201, body: '{ "id": "t8" }' }, // duplicate status ignored
          ],
        },
        {
          name: 'Get task',
          request: {
            method: 'GET',
            url: {
              raw: '{{baseUrl}}/tasks/:taskId',
              host: ['{{baseUrl}}'],
              path: ['tasks', ':taskId'],
              variable: [{ key: 'taskId', value: 't42' }],
            },
          },
        },
      ],
    },
    {
      name: 'Health',
      request: { method: 'GET', url: { raw: '{{baseUrl}}/health', host: ['{{baseUrl}}'], path: ['health'] } },
    },
  ],
};

describe('buildPostmanIR', () => {
  const ir = buildPostmanIR(COLLECTION);

  it('resolves the base URL from collection variables', () => {
    expect(ir.base).toBe('https://api.todo.test/v1');
    expect(ir.title).toBe('Todo API');
  });

  it('maps folders to groups and items to operations', () => {
    expect(ir.groups.map((g) => g.name).sort()).toEqual(['health', 'tasks']);
    const tasks = ir.groups.find((g) => g.name === 'tasks')!;
    expect(tasks.operations.map((op) => op.name)).toEqual(['listTasks', 'createTask', 'getTask']);
    expect(tasks.operations[0]!.method).toBe('GET');
    expect(tasks.operations[0]!.path).toBe('/tasks');
  });

  it('keeps :placeholder path params with example descriptions', () => {
    const getTask = ir.groups.find((g) => g.name === 'tasks')!.operations[2]!;
    expect(getTask.path).toBe('/tasks/:taskId');
    const pathParam = getTask.params.find((p) => p.location === 'path')!;
    expect(pathParam.wireName).toBe('taskId');
    expect(pathParam.required).toBe(true);
    expect(pathParam.schema.description).toBe('e.g. t42');
  });

  it('converts query params (enabled only) and headers', () => {
    const listTasks = ir.groups.find((g) => g.name === 'tasks')!.operations[0]!;
    const queries = listTasks.params.filter((p) => p.location === 'query');
    expect(queries.map((q) => q.wireName)).toEqual(['completed']);
    expect(queries[0]!.schema.type).toBe('string'); // never infers booleans from "true"
    expect(queries[0]!.description).toBe('Filter by completion');

    const header = listTasks.params.find((p) => p.location === 'header')!;
    expect(header.wireName).toBe('X-Request-Id');
  });

  it('infers body fields from raw JSON examples and marks them inferred', () => {
    const createTask = ir.groups.find((g) => g.name === 'tasks')!.operations[1]!;
    const body = createTask.params.filter((p) => p.location === 'body');
    expect(body.map((p) => p.wireName)).toEqual(['title', 'priority', 'tags', 'done']);
    expect(body[0]!.schema.type).toBe('string');
    expect(body[1]!.schema.type).toBe('integer');
    expect(body[2]!.schema.type).toBe('array');
    expect(body[2]!.schema.items?.type).toBe('string');
    expect(body[3]!.schema.type).toBe('boolean');
    for (const param of body) {
      expect(param.description).toBe('(inferred from example)');
      expect(param.required).toBe(true);
    }
  });

  it('infers response types from example bodies (first status wins)', () => {
    const listTasks = ir.groups.find((g) => g.name === 'tasks')!.operations[0]!;
    expect(listTasks.responds).toEqual([{ status: 200, type: 'array' }]);

    const createTask = ir.groups.find((g) => g.name === 'tasks')!.operations[1]!;
    expect(createTask.responds).toEqual([{ status: 201, type: 'hash' }]);

    const getTask = ir.groups.find((g) => g.name === 'tasks')!.operations[2]!;
    expect(getTask.responds).toEqual([]);
  });

  it('surfaces detected auth as IR notes', () => {
    expect(ir.notes).toContain(
      'Detected Postman auth "bearer" — configure the equivalent auth resolver on the client.',
    );
  });

  it('supports per-request base URL override and v2.0 string URLs', () => {
    expect(ir.groups.find((g) => g.name === 'health')!.operations[0]!.path).toBe('/health');
  });

  it('emits contract modules from the inferred IR', () => {
    const files = emitContracts(ir, { specOrigin: 'todo.postman_collection.json' });
    const tasksFile = files.find((f) => f.path === 'tasks.ts')!.content;
    expect(tasksFile).toContain('Detected Postman auth "bearer"');
    expect(tasksFile).toContain('createTask: contract("POST /tasks", {');
    expect(tasksFile).toContain('title: P.string({ required: true, in: "body", describe: "(inferred from example)" }),');
    expect(tasksFile).toContain('taskId: P.string({ required: true, describe: "e.g. t42" }),');
    expect(tasksFile).toContain('responds: [{ status: 200, type: "array" }],');
  });
});

describe('inferSchemaFromValue', () => {
  it('maps JSON values conservatively', () => {
    expect(inferSchemaFromValue(42)).toEqual({ type: 'integer' });
    expect(inferSchemaFromValue(4.5)).toEqual({ type: 'float' });
    expect(inferSchemaFromValue('42')).toEqual({ type: 'string' }); // never a number from a string
    expect(inferSchemaFromValue(true)).toEqual({ type: 'boolean' });
    expect(inferSchemaFromValue([1, 2])).toEqual({ type: 'array', items: { type: 'integer' } });
    expect(inferSchemaFromValue([])).toEqual({ type: 'array', items: undefined });
    expect(inferSchemaFromValue({ a: 1 })).toEqual({
      type: 'object',
      properties: { a: { type: 'integer' } },
      requiredProps: ['a'],
    });
    expect(inferSchemaFromValue(null)).toEqual({});
  });
});
