import type { StandardSchemaV1 } from '@standard-schema/spec';

import { noop } from '@mnaoumov/typescript-lib/function';
import {
  describe,
  expect,
  it
} from 'vitest';

import {
  ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT,
  BULK_OPERATION_EVENT_SCHEMA
} from './api-contract.ts';

async function isValid(schema: StandardSchemaV1, value: unknown): Promise<boolean> {
  const result = await schema['~standard'].validate(value);
  return result.issues === undefined;
}

// The copied contract is this plugin's own expectation of the provider, so its guards are exercised here.
describe('ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT', () => {
  it('validates bulk-operation arguments and results', async () => {
    const { moveMany, runInBatch, subscribeBulkOperations } = ADVANCED_RENAME_AND_DELETE_HANDLER_API_CONTRACT;
    expect(await isValid(moveMany.input, [{ moves: [{ newPath: 'B.md', oldPath: 'A.md' }] }])).toBe(true);
    expect(await isValid(moveMany.input, [{ moves: 'A.md' }])).toBe(false);
    expect(await isValid(runInBatch.input, [noop])).toBe(true);
    expect(await isValid(runInBatch.input, ['rename'])).toBe(false);
    expect(await isValid(subscribeBulkOperations.input, [noop])).toBe(true);
    expect(await isValid(subscribeBulkOperations.input, [null])).toBe(false);
    expect(await isValid(subscribeBulkOperations.output, noop)).toBe(true);
    expect(await isValid(subscribeBulkOperations.output, undefined)).toBe(false);
  });

  it('validates notification payloads', async () => {
    expect(await isValid(BULK_OPERATION_EVENT_SCHEMA, { operation: 'moveMany', phase: 'start' })).toBe(true);
    expect(await isValid(BULK_OPERATION_EVENT_SCHEMA, { isReplay: true, operation: 'runInBatch', phase: 'start' })).toBe(true);
    expect(await isValid(BULK_OPERATION_EVENT_SCHEMA, { isSuccessful: false, operation: 'runInBatch', phase: 'end' })).toBe(true);
    expect(await isValid(BULK_OPERATION_EVENT_SCHEMA, { operation: 'moveMany', phase: 'end' })).toBe(false);
  });
});
