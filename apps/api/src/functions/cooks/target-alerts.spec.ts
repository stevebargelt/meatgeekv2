import { ApnsConfigError } from '../../shared/apns/apns-config';
import { broadcastTemperatureHandler } from '../signalr/broadcast-temperature';
import { pushTokenId } from '../../shared/cosmos/push-tokens-repository';
import { recordTargetsReachedHandler, TargetsNotRecordedError } from './record-targets-reached';
import { ALERT_ACCEPT_LAG_METRIC } from './target-alerts';
import {
  at,
  batchOf,
  COOK,
  Harness,
  logsOf,
  noopMeter,
  OWNER,
  phoneToken,
} from './targets-harness.testing';

/**
 * #244 — a reached target sends an alert to every registered phone. Each rule
 * is driven through the reading-batch handler the way the Functions host runs
 * it, with Apple as a fake transport behind the real APNs client and a fake
 * clock. What is asserted is what Apple was sent, what the cook says, and which
 * phones are still registered.
 */

const PHONE_1 = phoneToken(1);
const PHONE_2 = phoneToken(2);

describe('target alerts', () => {
  it("sends one Time Sensitive alert to each of the owner's phones when a channel reaches its target", async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);
    await h.registerPhone(PHONE_2);

    await h.send({ n: 1, probe1Temp: 203 }, { n: 2, probe1Temp: 204 });

    expect(h.apple.alerts()).toEqual([
      {
        token: PHONE_1,
        title: 'Probe 1 reached 203 °F',
        body: 'Brisket',
        thread: COOK,
        cookId: COOK,
      },
      {
        token: PHONE_2,
        title: 'Probe 1 reached 203 °F',
        body: 'Brisket',
        thread: COOK,
        cookId: COOK,
      },
    ]);
    const [request] = h.apple.sent;
    expect(request.headers).toMatchObject({
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-topic': 'com.meatgeek.ios',
    });
    expect(JSON.parse(request.body)).toEqual({
      aps: {
        alert: { title: 'Probe 1 reached 203 °F', body: 'Brisket' },
        sound: 'default',
        'interruption-level': 'time-sensitive',
        'thread-id': COOK,
      },
      cookId: COOK,
    });
  });

  it('sends nothing for one reading at the target', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);

    await h.send({ n: 1, probe1Temp: 190 }, { n: 2, probe1Temp: 260 }, { n: 3, probe1Temp: 191 });

    expect(h.apple.sent).toHaveLength(0);
  });

  it('names the grill, and alerts once while a channel hovers at its target', async () => {
    const h = new Harness();
    h.startCook({ grill: 225 });
    await h.registerPhone(PHONE_1);

    await h.send({ n: 1, grillTemp: 226 }, { n: 2, grillTemp: 227 });
    await h.send({ n: 3, grillTemp: 224 }, { n: 4, grillTemp: 226 });
    await h.send({ n: 5, grillTemp: 225 }, { n: 6, grillTemp: 225 });

    expect(h.apple.titles()).toEqual(['Grill reached 225 °F']);
  });

  it("shows the temperature in the device's unit, converted as the live panel converts it", async () => {
    const h = new Harness();
    h.unit = 'celsius';
    h.startCook({ grill: 225, probe1: 203 });
    await h.registerPhone(PHONE_1);

    await h.send(
      { n: 1, grillTemp: 230, probe1Temp: 204 },
      { n: 2, grillTemp: 231, probe1Temp: 205 }
    );

    // (225 - 32) × 5/9 = 107.2̅ → 107.2; (203 - 32) × 5/9 = 95.
    expect(h.apple.titles()).toEqual(['Grill reached 107.2 °C', 'Probe 1 reached 95 °C']);
  });

  it('sends each target reached as its own alert, in one thread for the cook', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203, probe2: 165 });
    await h.registerPhone(PHONE_1);

    await h.send(
      { n: 1, probe1Temp: 204, probe2Temp: 170 },
      { n: 2, probe1Temp: 205, probe2Temp: 171 }
    );

    const alerts = h.apple.alerts();
    expect(alerts.map(a => a.title)).toEqual(['Probe 1 reached 203 °F', 'Probe 2 reached 165 °F']);
    expect(new Set(alerts.map(a => a.thread))).toEqual(new Set([COOK]));
    expect(alerts.every(a => a.cookId === COOK)).toBe(true);
  });

  it('says how long ago a late reading reached the target, as a duration', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);

    // The device was offline and sends its backlog 40 minutes later.
    h.now = new Date(Date.parse(at(2)) + 40 * 60_000);
    await h.sendAsIs({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 });

    expect(h.apple.titles()).toEqual(['Probe 1 reached 203 °F 40 minutes ago']);
    expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(2) } });
  });

  it('counts hours in a long delay, and adds nothing up to 2 minutes', async () => {
    const late = new Harness();
    late.startCook({ probe1: 203 });
    await late.registerPhone(PHONE_1);
    late.now = new Date(Date.parse(at(2)) + 125 * 60_000);
    await late.sendAsIs({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 });

    const onTime = new Harness();
    onTime.startCook({ probe1: 203 });
    await onTime.registerPhone(PHONE_1);
    onTime.now = new Date(Date.parse(at(2)) + 2 * 60_000);
    await onTime.sendAsIs({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 });

    expect(late.apple.titles()).toEqual(['Probe 1 reached 203 °F 2 hours 5 minutes ago']);
    expect(onTime.apple.titles()).toEqual(['Probe 1 reached 203 °F']);
  });

  it('alerts again when a probe re-arms and is reached again', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);

    await h.send({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 });
    // Moved to a cold piece of meat: 15 °F below re-arms.
    await h.send({ n: 3, probe1Temp: 150 });
    await h.send({ n: 40, probe1Temp: 203 }, { n: 41, probe1Temp: 204 });

    expect(h.apple.titles()).toEqual(['Probe 1 reached 203 °F', 'Probe 1 reached 203 °F']);
  });

  it('alerts the grill once per target, even after the lid is lifted', async () => {
    const h = new Harness();
    h.startCook({ grill: 225 });
    await h.registerPhone(PHONE_1);

    await h.send({ n: 1, grillTemp: 230 }, { n: 2, grillTemp: 231 });
    await h.send({ n: 3, grillTemp: 150 }, { n: 4, grillTemp: 120 });
    await h.send({ n: 5, grillTemp: 226 }, { n: 6, grillTemp: 227 });

    expect(h.apple.titles()).toEqual(['Grill reached 225 °F']);
  });

  it('sends nothing for a reading that arrives after its cook was stopped', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);
    await h.send({ n: 1, probe1Temp: 204 });
    await h.repository.stopCook(OWNER, COOK, at(2));

    await h.send({ n: 2, probe1Temp: 205 }, { n: 3, probe1Temp: 206 });

    expect(h.apple.sent).toHaveLength(0);
  });

  it('records a reach as alerted only once Apple accepts, and sends again when Apple gave no answer', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);
    h.apple.answers.set(PHONE_1, 'no-answer');

    const { events, context } = batchOf([
      { n: 1, probe1Temp: 204 },
      { n: 2, probe1Temp: 205 },
    ]);
    h.now = new Date(at(2));
    // The batch throws so the host retries it.
    await expect(recordTargetsReachedHandler(events, context, h.deps)).rejects.toThrow(
      TargetsNotRecordedError
    );
    expect(h.apple.sent).toHaveLength(1);
    // The reach itself is recorded; only its alert is not.
    expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(2) } });

    // The host's retry of the same batch, once Apple answers: sent again.
    h.apple.answers.delete(PHONE_1);
    await recordTargetsReachedHandler(events, context, h.deps);
    expect(h.apple.titles()).toEqual(['Probe 1 reached 203 °F', 'Probe 1 reached 203 °F']);

    // Recorded now: the next readings send nothing.
    await h.send({ n: 3, probe1Temp: 206 });
    expect(h.apple.sent).toHaveLength(2);
  });

  it('sends again when Apple was unavailable, and records a refusal as an answer', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);

    h.apple.answers.set(PHONE_1, { status: 503, reason: 'ServiceUnavailable' });
    await expect(h.send({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 })).rejects.toThrow(
      TargetsNotRecordedError
    );
    h.apple.answers.set(PHONE_1, { status: 429, reason: 'TooManyRequests' });
    await expect(h.send({ n: 3, probe1Temp: 205 })).rejects.toThrow(TargetsNotRecordedError);

    // A refusal for another reason does not hold the batch up, and is final.
    h.apple.answers.set(PHONE_1, { status: 403, reason: 'InvalidProviderToken' });
    await h.send({ n: 4, probe1Temp: 205 });

    h.apple.answers.delete(PHONE_1);
    await h.send({ n: 5, probe1Temp: 205 });

    expect(h.apple.sent).toHaveLength(3);
    // No failure deleted the phone.
    expect(await h.phoneIds()).toEqual([pushTokenId(PHONE_1)]);
  });

  it("does not repeat an alert on a phone that accepted it when another phone's push is refused", async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);
    await h.registerPhone(PHONE_2);
    h.apple.answers.set(PHONE_2, { status: 400, reason: 'DeviceTokenNotForTopic' });

    await h.send({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 });
    await h.send({ n: 3, probe1Temp: 205 });
    await h.send({ n: 4, probe1Temp: 206 });

    expect(h.apple.sent.map(r => r.deviceToken)).toEqual([PHONE_1, PHONE_2]);
    expect(await h.phoneIds()).toHaveLength(2);
  });

  it('deletes a token Apple answers 410 or BadDeviceToken for, and keeps the others', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203, probe2: 165 });
    const gone = phoneToken(3);
    const bad = phoneToken(4);
    await h.registerPhone(PHONE_1);
    await h.registerPhone(gone);
    await h.registerPhone(bad);
    h.apple.answers.set(gone, { status: 410, reason: 'Unregistered' });
    h.apple.answers.set(bad, { status: 400, reason: 'BadDeviceToken' });

    await h.send(
      { n: 1, probe1Temp: 204, probe2Temp: 170 },
      { n: 2, probe1Temp: 205, probe2Temp: 171 }
    );

    expect(await h.phoneIds()).toEqual([pushTokenId(PHONE_1)]);
    // A dead token is not tried again for the second alert of the batch.
    expect(h.apple.sent.map(r => r.deviceToken)).toEqual([PHONE_1, gone, bad, PHONE_1]);
    // Both reaches are done: every phone had a final answer.
    await h.send({ n: 3, probe1Temp: 205, probe2Temp: 171 });
    expect(h.apple.sent).toHaveLength(4);
  });

  it('does not delete a token for any other refusal', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);
    h.apple.answers.set(PHONE_1, { status: 400, reason: 'BadTopic' });

    await h.send({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 });

    expect(await h.phoneIds()).toEqual([pushTokenId(PHONE_1)]);
  });

  it('sends nothing to a user with no phones, and no old alert to a phone registered later', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });

    await h.send({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 });
    await h.registerPhone(PHONE_1);
    await h.send({ n: 3, probe1Temp: 205 });

    expect(h.apple.sent).toHaveLength(0);
  });

  it('never alerts the phones of a user who does not own the cook', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);
    await h.registerPhone(PHONE_2, 'someone-else');

    await h.send({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 });

    expect(h.apple.sent.map(r => r.deviceToken)).toEqual([PHONE_1]);
  });

  it('records the time from the reach to Apple accepting the alert', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);
    // The batch arrives 3 s after the reading; Apple answers 1 s later.
    h.now = new Date(Date.parse(at(2)) + 3_000);
    h.apple.onSend = () => {
      h.now = new Date(h.now.getTime() + 1_000);
    };

    await h.sendAsIs({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 });

    expect(h.meter.records).toEqual([
      { name: ALERT_ACCEPT_LAG_METRIC, value: 4_000, attributes: {} },
    ]);
  });

  it('marks the accept time of a late reach as late', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);
    h.now = new Date(Date.parse(at(2)) + 40 * 60_000);

    await h.sendAsIs({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 });

    expect(h.meter.records).toEqual([
      { name: ALERT_ACCEPT_LAG_METRIC, value: 40 * 60_000, attributes: { late: true } },
    ]);
  });

  it('writes no push token, user id or cook id to a log', async () => {
    const h = new Harness();
    h.startCook({ probe1: 203 });
    await h.registerPhone(PHONE_1);
    await h.registerPhone(PHONE_2);
    h.apple.answers.set(PHONE_2, { status: 410, reason: 'Unregistered' });

    const context = await h.send({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 });
    h.apple.answers.set(PHONE_1, 'no-answer');
    h.startCook({ probe1: 100 });
    const { events, context: failing } = batchOf([
      { n: 3, probe1Temp: 204 },
      { n: 4, probe1Temp: 205 },
    ]);
    const error = await recordTargetsReachedHandler(events, failing, h.deps).catch((e: Error) => e);

    const logs = [...logsOf(context), ...logsOf(failing), String(error)].join('\n');
    expect(logs).toContain('alertsAccepted=1');
    expect(logs).toContain('deadTokens=1');
    expect(logs).toContain('alertsUnanswered=1');
    for (const secret of [PHONE_1, PHONE_2, '0101', OWNER, COOK]) {
      expect(logs).not.toContain(secret);
    }
  });

  describe('when alerting fails', () => {
    it('leaves the live push of the same batch intact', async () => {
      const h = new Harness();
      h.startCook({ probe1: 203 });
      await h.registerPhone(PHONE_1);
      h.apple.answers.set(PHONE_1, 'no-answer');
      const pushed: unknown[] = [];
      const { events, context } = batchOf([
        { n: 1, probe1Temp: 204 },
        { n: 2, probe1Temp: 205 },
      ]);
      (context as unknown as { extraOutputs: unknown }).extraOutputs = {
        set: (_output: unknown, value: unknown) => pushed.push(value),
      };

      // Both registrations run on the same events, each on its own consumer
      // group: this is the alert failing beside the push.
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
      expect((pushed[0] as Array<{ userId: string }>).map(m => m.userId)).toEqual([OWNER, OWNER]);
    });

    it('retries when the phones cannot be read, and still records the reach', async () => {
      const h = new Harness();
      h.startCook({ probe1: 203 });
      await h.registerPhone(PHONE_1);
      h.usersContainer.failNext('read', 503);

      await expect(h.send({ n: 1, probe1Temp: 204 }, { n: 2, probe1Temp: 205 })).rejects.toThrow(
        TargetsNotRecordedError
      );
      expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(2) } });

      await h.send({ n: 3, probe1Temp: 205 });
      expect(h.apple.titles()).toEqual(['Probe 1 reached 203 °F']);
    });

    it('does not retry the batch when the APNs settings are missing, and sends once they are in place', async () => {
      const h = new Harness();
      h.startCook({ probe1: 203 });
      await h.registerPhone(PHONE_1);
      const { events, context } = batchOf([
        { n: 1, probe1Temp: 204 },
        { n: 2, probe1Temp: 205 },
      ]);

      // A retry cannot fix a missing setting, so the batch does not throw.
      await recordTargetsReachedHandler(events, context, {
        ...h.deps,
        getApns: () => {
          throw new ApnsConfigError('APNS_KEY_ID_missing');
        },
      });
      expect(h.apple.sent).toHaveLength(0);
      expect((await h.cook()).targetsReached).toEqual({ probe1: { reachedAt: at(2) } });
      expect(logsOf(context).join('\n')).toContain('alertsUnconfigured=1');

      // Not recorded: it goes out with the cook's next batch.
      await h.send({ n: 3, probe1Temp: 205 });
      expect(h.apple.titles()).toEqual(['Probe 1 reached 203 °F']);
    });
  });
});
