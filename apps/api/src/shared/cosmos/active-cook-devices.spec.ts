import type { Container } from '@azure/cosmos';

import { CooksRepository } from './cooks-repository';

/** #231 — the cross-partition read behind the device-silence check. */
describe('CooksRepository.listActiveCookDevices', () => {
  function container(resources: unknown[]) {
    const calls: Array<{ spec: unknown; options: unknown }> = [];
    const fake = {
      items: {
        query: (spec: unknown, options: unknown) => {
          calls.push({ spec, options });
          return { fetchAll: async () => ({ resources, requestCharge: 3.5 }) };
        },
      },
    };
    return { calls, container: fake as unknown as Container };
  }

  it('queries active cooks across every user, excluding the device lock documents', async () => {
    const { calls, container: c } = container([{ deviceId: 'pi-1' }, { deviceId: 'pi-2' }]);

    const result = await new CooksRepository(c).listActiveCookDevices();

    expect(result).toEqual({ deviceIds: ['pi-1', 'pi-2'], requestCharge: 3.5 });
    expect(calls).toHaveLength(1);
    const spec = calls[0].spec as {
      query: string;
      parameters: Array<{ name: string; value: unknown }>;
    };
    expect(spec.query).toContain('c.status = @status');
    expect(spec.query).toContain('NOT IS_DEFINED(c.docType)');
    expect(spec.query).toMatch(/^SELECT c\.deviceId FROM c/);
    expect(spec.parameters).toEqual([{ name: '@status', value: 'active' }]);
    // No partition key: the check spans every user's partition.
    expect(
      (calls[0].options as { partitionKey?: unknown } | undefined)?.partitionKey
    ).toBeUndefined();
  });

  it('drops a cook without a usable device id', async () => {
    const { container: c } = container([
      { deviceId: 'pi-1' },
      {},
      { deviceId: '' },
      { deviceId: 7 },
    ]);

    const result = await new CooksRepository(c).listActiveCookDevices();

    expect(result.deviceIds).toEqual(['pi-1']);
  });
});
