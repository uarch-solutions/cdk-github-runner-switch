import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module of the function (no types)
import * as fn from '../lambda/index.mjs';

const c = fn.config({ REPOSITORY: 'acme/app' });

describe('control function rules', () => {
  it('config defaults and overrides', () => {
    expect(c).toMatchObject({ label: 'aws', onDemandLabel: 'aws-ondemand', thresholdMinutes: 1900, maxInstances: 6, switchVariable: 'RUNNER', billing: 'organization' });
    expect(fn.config({ LABEL: 'spot', INSTANCE_TYPES: 'a, b', BILLING: 'user' })).toMatchObject({ onDemandLabel: 'spot-ondemand', instanceTypes: ['a', 'b'], billing: 'user' });
  });

  it('accepts only a valid GitHub signature', () => {
    const body = '{"action":"queued"}';
    const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    expect(fn.validSignature('s3cret', body, sig)).toBe(true);
    expect(fn.validSignature('s3cret', `${body} `, sig)).toBe(false);
    expect(fn.validSignature('other', body, sig)).toBe(false);
    expect(fn.validSignature('s3cret', body, undefined)).toBe(false);
    expect(fn.validSignature('', body, sig)).toBe(false);
  });

  it('launches only for queued self-hosted jobs with our labels; on-demand label skips Spot', () => {
    const job = (labels: string[], action = 'queued') => ({ action, workflow_job: { id: 1, labels } });
    expect(fn.runnerRequest(job(['self-hosted', 'linux', 'arm64', 'aws']), c)).toEqual({ onDemand: false });
    expect(fn.runnerRequest(job(['self-hosted', 'linux', 'arm64', 'aws-ondemand']), c)).toEqual({ onDemand: true });
    expect(fn.runnerRequest(job(['ubuntu-24.04-arm']), c)).toBeNull();
    expect(fn.runnerRequest(job(['self-hosted', 'aws'], 'completed'), c)).toBeNull();
    expect(fn.runnerRequest(job(['self-hosted', 'other']), c)).toBeNull();
  });

  it('launch plan: Spot on every type × subnet first, then on-demand', () => {
    const plan = fn.launchPlan(false, ['a', 'b'], c);
    expect(plan).toHaveLength(12);
    expect(plan.slice(0, 6).every((p: { spot: boolean }) => p.spot)).toBe(true);
    expect(plan.slice(6).every((p: { spot: boolean }) => !p.spot)).toBe(true);
    expect(fn.launchPlan(true, ['a'], c).every((p: { spot: boolean }) => !p.spot)).toBe(true);
  });

  it('switch: AWS at the threshold, back to GitHub when the month resets, otherwise keep', () => {
    expect(fn.nextRunner(1900, 'github', c)).toBe('aws');
    expect(fn.nextRunner(1899, 'github', c)).toBeNull();
    expect(fn.nextRunner(2500, 'aws', c)).toBeNull();
    expect(fn.nextRunner(12, 'aws', c)).toBe('github');
  });

  it('counts only this month Actions minutes', () => {
    const usage = { usageItems: [
      { date: '2026-10-01T00:00:00Z', product: 'actions', unitType: 'Minutes', quantity: 2018 },
      { date: '2026-10-01T00:00:00Z', product: 'actions', unitType: 'GigabyteHours', quantity: 8.5 },
      { date: '2026-09-01T00:00:00Z', product: 'actions', unitType: 'Minutes', quantity: 917 },
    ] };
    expect(fn.minutesThisMonth(usage, new Date('2026-10-10T12:00:00Z'))).toBe(2018);
    expect(fn.minutesThisMonth(usage, new Date('2026-11-01T01:00:00Z'))).toBe(0);
    expect(fn.minutesThisMonth(null)).toBe(0);
  });

  it('billing report of the organization or of the user', () => {
    expect(fn.usagePath('acme/app', 'organization')).toBe('/orgs/acme/settings/billing/usage');
    expect(fn.usagePath('jane/app', 'user')).toBe('/users/jane/settings/billing/usage');
  });

  it('reconciliation launches only what is missing per label, within the cap', () => {
    expect(fn.missingRunners({ queued: { aws: 3 }, active: { aws: 2 }, busy: { aws: 1 } }, c)).toEqual({ aws: 2 });
    expect(fn.missingRunners({ queued: { 'aws-ondemand': 1 }, active: { aws: 2 }, busy: {} }, c)).toEqual({ 'aws-ondemand': 1 });
    expect(fn.missingRunners({ queued: { aws: 4 }, active: { aws: 6 }, busy: { aws: 6 } }, c)).toEqual({});
    expect(fn.missingRunners({ queued: { aws: 8 }, active: { aws: 5 }, busy: { aws: 5 } }, c)).toEqual({ aws: 1 });
    expect(fn.missingRunners({ queued: {}, active: {}, busy: {} }, c)).toEqual({});
  });

  it('user data runs one job and shuts down, with the timeout guard; rejects a malformed JIT config', () => {
    const script = Buffer.from(fn.userData('QUJD+/=', fn.config({ MAX_JOB_MINUTES: '45' })), 'base64').toString();
    expect(script).toContain('shutdown -h +45');
    expect(script).toContain("./run.sh --jitconfig 'QUJD+/='");
    expect(script.trim().endsWith('shutdown -h now')).toBe(true);
    expect(() => fn.userData("x'; rm -rf /", c)).toThrow();
  });
});
