import { CooksRepository } from '../../shared/cosmos/cooks-repository';
import { broadcastTemperatureHandler } from '../signalr/broadcast-temperature';
import {
  recordTargetsReachedHandler,
  TargetsNotRecordedError,
  type RecordTargetsReachedDeps,
} from './record-targets-reached';
import { at, batchOf, COOK, DEVICE, Harness, noopMeter, OWNER } from './targets-harness.testing';

/**
 * The target rule, driven the way the Functions host drives the Event Hub
 * trigger (see ./targets-harness.testing.ts). The cook is read back through
 * the repository, as GET /cooks/{id} reads it. Time is the readings' own
 * timestamps; nothing reads the wall clock. The alerts the rule sends are in
 * ./target-alerts.spec.ts.
 */

describe('recordTargetsReachedHandler', () => {
  it('records a probe as reached at the second of two readings in a row at or above its target', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    await h.send({ n: 1, probe1Temp: 203 }, { n: 2, probe1Temp: 204 });

    expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(2) } });
  });

  it('does not count one reading at the target: a single spike is not reached', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    await h.send({ n: 1, probe1Temp: 190 }, { n: 2, probe1Temp: 260 }, { n: 3, probe1Temp: 191 });
    await h.send({ n: 4, probe1Temp: 204 });

    expect((await h.cook()).targetsReached).toBeUndefined();
  });

  it('counts two readings in a row that fall in different batches', async () => {
    const h = new Harness();
    h.startCook({ grill: 225 });

    await h.send({ n: 1, grillTemp: 226 });
    await h.send({ n: 2, grillTemp: 227 });

    expect((await h.cook()).targetsReached).toEqual({ grill: { reachedAt: at(2) } });
  });

  it('keeps a channel reached, with its first time, while it hovers at the target or dips less than 15 °F', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    await h.send({ n: 1, probe1Temp: 203 }, { n: 2, probe1Temp: 203 });
    await h.send({ n: 3, probe1Temp: 202 }, { n: 4, probe1Temp: 189 }, { n: 5, probe1Temp: 204 });
    await h.send({ n: 6, probe1Temp: 205 }, { n: 7, probe1Temp: 206 });

    expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(2) } });
  });

  it('re-arms a probe that reads 15 °F or more below its target, and records the next reach with a new time', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203, probe2: 165 });

    await h.send(
      { n: 1, probe1Temp: 203, probe2Temp: 170 },
      { n: 2, probe1Temp: 204, probe2Temp: 171 }
    );
    expect((await h.cook()).targetsReached).toEqual({
      probe1: { reachedAt: at(2) },
      probe2: { reachedAt: at(2) },
    });

    // The probe is moved to a cold piece of meat: exactly 15 below re-arms.
    await h.send({ n: 3, probe1Temp: 188, probe2Temp: 171 });
    expect((await h.cook()).targetsReached).toEqual({ probe2: { reachedAt: at(2) } });

    await h.send({ n: 40, probe1Temp: 203 }, { n: 41, probe1Temp: 203.5 });
    expect((await h.cook()).targetsReached).toEqual({
      probe1: { reachedAt: at(41) },
      probe2: { reachedAt: at(2) },
    });
  });

  it('never re-arms the grill by falling', async () => {
    const h = new Harness();
    h.startCook({ grill: 225 });

    await h.send({ n: 1, grillTemp: 230 }, { n: 2, grillTemp: 231 });
    // The lid is lifted: the chamber falls far more than 15 °F, then recovers.
    await h.send({ n: 3, grillTemp: 150 }, { n: 4, grillTemp: 120 });
    await h.send({ n: 5, grillTemp: 226 }, { n: 6, grillTemp: 227 });

    expect((await h.cook()).targetsReached).toEqual({ grill: { reachedAt: at(2) } });
  });

  it('reaches a target already met when the cook starts under the same rule', async () => {
    const h = new Harness();
    h.startCook({ grill: 100, probe1: 50 });

    await h.send({ n: 1, grillTemp: 240, probe1Temp: 60 });
    expect((await h.cook()).targetsReached).toBeUndefined();

    await h.send({ n: 2, grillTemp: 241, probe1Temp: 61 });
    expect((await h.cook()).targetsReached).toEqual({
      grill: { reachedAt: at(2) },
      probe1: { reachedAt: at(2) },
    });
  });

  it('never reaches a channel with no reading and leaves its state unchanged', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203, probe2: 160 });

    // probe2 is unplugged for the first readings, then plugged back in.
    await h.send({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 });
    expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(2) } });

    await h.send({ n: 3, probe2Temp: 161 });
    // A reading without probe2 changes nothing for it, pending included.
    await h.send({ n: 4, probe1Temp: 205 });
    await h.send({ n: 5, probe2Temp: 162 });
    expect((await h.cook()).targetsReached).toEqual({
      probe1: { reachedAt: at(2) },
      probe2: { reachedAt: at(5) },
    });
  });

  it('never reaches a channel that has no target', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    await h.send({ n: 1, grillTemp: 900, probe2Temp: 900 }, { n: 2, grillTemp: 900, probe2Temp: 900 });

    expect((await h.cook()).targetsReached).toBeUndefined();
  });

  it('changes nothing for a reading that arrives after its cook was stopped', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.send({ n: 1, probe1Temp: 204 });

    const { cook } = await h.repository.stopCook(OWNER, COOK, at(2));
    const writesBefore = h.container.replaces.length;

    // The device's backlog arrives after the stop.
    await h.send({ n: 3, probe1Temp: 205 }, { n: 4, probe1Temp: 206 });

    expect(h.container.replaces).toHaveLength(writesBefore);
    expect(await h.cook()).toEqual(cook);
    expect((await h.cook()).targetsReached).toBeUndefined();
  });

  it('records the timestamp of the second reading, not the time a late reading arrived', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    // The device was offline for an hour and sends its buffered backlog now:
    // the batch arrives long after the readings were taken.
    const { events, context } = batchOf([
      { n: 1, probe1Temp: 200 },
      { n: 2, probe1Temp: 203 },
      { n: 3, probe1Temp: 204 },
    ]);
    const meta = context.triggerMetadata as { enqueuedTimeUtcArray: string[] };
    meta.enqueuedTimeUtcArray = meta.enqueuedTimeUtcArray.map(() => at(720));
    await recordTargetsReachedHandler(events, context, h.deps);

    expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(3) } });
  });

  it('applies the readings of a batch in timestamp order', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    await h.send({ n: 3, probe1Temp: 204 }, { n: 1, probe1Temp: 150 }, { n: 2, probe1Temp: 203 });

    expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(3) } });
  });

  it('does not count a reading the event hub delivers twice as two readings', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    await h.send({ n: 1, probe1Temp: 204 });
    // The host retries the same batch.
    await h.send({ n: 1, probe1Temp: 204 });
    expect((await h.cook()).targetsReached).toBeUndefined();

    await h.send({ n: 2, probe1Temp: 204 });
    await h.send({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 204 });
    expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(2) } });
  });

  it('does not re-arm a probe on a reading older than its reach', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    await h.send({ n: 2, probe1Temp: 204 }, { n: 3, probe1Temp: 205 });
    // A batch from before the reach is delivered again: the probe was cold then.
    await h.send({ n: 1, probe1Temp: 150 });

    expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(3) } });
  });

  it('holds its state across a restart and a second instance: everything it needs is on the cook', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    await h.send({ n: 1, probe1Temp: 204 });

    // A different instance: a new repository and handler over the same store,
    // with nothing carried over in memory.
    const other = new CooksRepository(h.container.asContainer());
    const { events, context } = batchOf([{ n: 2, probe1Temp: 205 }]);
    await recordTargetsReachedHandler(events, context, {
      ...h.deps,
      ownerOf: async () => OWNER,
      getRepository: () => other,
    });

    expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(2) } });
  });

  it('does not undo a stop that lands between its read and its write', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.send({ n: 1, probe1Temp: 204 });

    let stopped = false;
    h.container.beforeReplace = () => {
      if (!stopped) {
        stopped = true;
        // The owner's stop is written first; our replace now carries a stale ETag.
        h.container.seed({ ...h.container.peek(OWNER, COOK), status: 'completed', endTime: at(2) });
      }
    };
    await h.send({ n: 2, probe1Temp: 205 });

    const cook = await h.cook();
    expect(cook.status).toBe('completed');
    expect(cook.endTime).toBe(at(2));
    expect(cook.targetsReached).toBeUndefined();
  });

  it('only counts a reading for the cook on the device that sent it', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    // Another device of the same owner tags its readings with this cook's id.
    const harness = { ...h.deps, ownerOf: async () => OWNER };
    const { events, context } = batchOf([
      { n: 1, probe1Temp: 204, deviceId: 'smoker-b' },
      { n: 2, probe1Temp: 205, deviceId: 'smoker-b' },
    ]);
    await recordTargetsReachedHandler(events, context, harness);

    expect((await h.cook()).targetsReached).toBeUndefined();
  });

  it('attributes no untagged reading to a cook', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    await h.send({ n: 1, probe1Temp: 204, cookId: '' }, { n: 2, probe1Temp: 205, cookId: '' });

    expect((await h.cook()).targetsReached).toBeUndefined();
    expect(h.container.reads).toEqual([{ id: COOK, partitionKey: OWNER }]);
  });

  it('reads only the device owner, the cook and the owner\'s phones, never a notification preference', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    const lookups: string[] = [];

    // The deps reach the device owner (a user id, nothing else), the cooks
    // container and the owner's phones. The fake containers serve those
    // documents alone: any query, or any read of a user or device settings
    // document, would show up here.
    const { events, context } = batchOf([
      { n: 1, probe1Temp: 204 },
      { n: 2, probe1Temp: 205 },
    ]);
    await recordTargetsReachedHandler(events, context, {
      ...h.deps,
      ownerOf: async deviceId => {
        lookups.push(deviceId);
        return OWNER;
      },
    });

    expect(lookups).toEqual([DEVICE]);
    // The rule's read, then the alert's record of the reach.
    expect(h.container.reads.map(r => r.id)).toEqual([COOK, COOK]);
    expect(h.usersContainer.calls.map(c => [c.operation, c.id])).toEqual([
      ['read', `push-tokens:${OWNER}`],
    ]);
    expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(2) } });
  });

  it('writes the cook only when its state changes', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    await h.send({ n: 1, probe1Temp: 150 }, { n: 2, probe1Temp: 160 });
    expect(h.container.replaces).toHaveLength(0);

    // The reach is written, then its alert is recorded: two writes, once.
    await h.send({ n: 3, probe1Temp: 204 }, { n: 4, probe1Temp: 205 });
    await h.send({ n: 5, probe1Temp: 205 }, { n: 6, probe1Temp: 206 });
    expect(h.container.replaces).toHaveLength(2);
  });

  it('never returns the pending reading: the cook carries reached channels only', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    await h.send({ n: 1, probe1Temp: 204 });

    expect(h.container.peek(OWNER, COOK)).toHaveProperty('targetsPending', { probe1: at(1) });
    expect(Object.keys(await h.cook())).not.toContain('targetsPending');
  });

  it('logs one line of counts per batch, with no ids', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    const { events, context } = batchOf([
      { n: 1, probe1Temp: 204 },
      { n: 2, probe1Temp: 205, cookId: '' },
    ]);

    await recordTargetsReachedHandler(events, context, h.deps);

    const logs = (context as unknown as { logs: string[] }).logs;
    expect(logs).toEqual([
      'recordTargetsReached cooks=1 updated=1 notActive=0 failed=0 untagged=1 skipped=0 unowned=0 lookupFailed=0' +
        ' alertsAccepted=0 alertsUnanswered=0 alertsRefused=0 deadTokens=0',
    ]);
    expect(logs.join('\n')).not.toMatch(/smoker|owner|cook-1/);
  });

  describe('when it fails', () => {
    it('records every other cook of the batch, then throws with no ids so the host retries', async () => {
      const h = new Harness();
      h.startCook({ probe1: 203 });
      h.container.seed({
        id: 'cook-2',
        userId: 'owner-b',
        deviceId: 'smoker-b',
        name: 'Ribs',
        status: 'active',
        startTime: at(0),
        targetTemps: { probe1: 190 },
      });
      h.container.beforeReplace = id => {
        if (id === 'cook-2') {
          throw Object.assign(new Error('https://acct.documents.azure.com 503'), { code: 503 });
        }
      };
      const { events, context } = batchOf([
        { n: 1, probe1Temp: 204 },
        { n: 1, probe1Temp: 195, deviceId: 'smoker-b', cookId: 'cook-2' },
        { n: 2, probe1Temp: 205 },
        { n: 2, probe1Temp: 196, deviceId: 'smoker-b', cookId: 'cook-2' },
      ]);
      const deps: RecordTargetsReachedDeps = {
        ...h.deps,
        ownerOf: async id => (id === 'smoker-b' ? 'owner-b' : OWNER),
      };

      const run = recordTargetsReachedHandler(events, context, deps);
      await expect(run).rejects.toThrow(TargetsNotRecordedError);
      await run.catch((error: Error) => {
        expect(error.message).not.toMatch(/documents\.azure\.com|smoker|owner|cook-/);
      });
      expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(2) } });

      // The retry, once Cosmos is back, records the failed cook from the same batch.
      h.container.beforeReplace = () => undefined;
      await recordTargetsReachedHandler(events, context, deps);
      const { cook } = await h.repository.getCook('owner-b', 'cook-2');
      expect(cook?.targetsReached).toEqual({ probe1: { reachedAt: at(2) } });
      expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(2) } });
    });

    it('throws when an owner read fails, so the host retries the batch', async () => {
      const h = new Harness();
      h.startCook({ probe1: 203 });
      const { events, context } = batchOf([{ n: 1, probe1Temp: 204 }]);

      await expect(
        recordTargetsReachedHandler(events, context, {
          ...h.deps,
          ownerOf: async () => {
            throw new Error('cosmos down');
          },
        })
      ).rejects.toThrow(TargetsNotRecordedError);
    });

    it('leaves the live push of the same batch intact', async () => {
      const h = new Harness();
      h.startCook({ probe1: 203 });
      h.container.beforeReplace = () => {
        throw new Error('cosmos down');
      };
      const pushed: unknown[] = [];
      const { events, context } = batchOf([
        { n: 1, probe1Temp: 204 },
        { n: 2, probe1Temp: 205 },
      ]);
      (context as unknown as { extraOutputs: unknown }).extraOutputs = {
        set: (_output: unknown, value: unknown) => pushed.push(value),
      };

      // The Functions host runs both registrations on the same events, each on
      // its own consumer group; this is the rule failing beside the push.
      const [push, rule] = await Promise.allSettled([
        broadcastTemperatureHandler(events, context, {
          ownerOf: h.deps.ownerOf,
          now: () => new Date(at(3)),
          meter: noopMeter,
        }),
        recordTargetsReachedHandler(events, context, h.deps),
      ]);

      expect(rule.status).toBe('rejected');
      expect(push.status).toBe('fulfilled');
      expect(pushed).toHaveLength(1);
      expect((pushed[0] as Array<{ userId: string }>).map(m => m.userId)).toEqual([OWNER, OWNER]);
    });
  });
});
