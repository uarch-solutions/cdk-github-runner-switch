// cdk-github-runner-switch — control function.
//
// 1. Webhook `workflow_job` from the GitHub App → one disposable EC2 machine (Spot first) with a single-use (JIT)
//    runner registration for the queued job.
// 2. Every few minutes (`reconcile`) → queued jobs that have no machine (lost webhook, cap reached) get one.
// 3. Every half hour (`check-usage`) → flips the repository variable (default `RUNNER`) between `github` and `aws`
//    according to the GitHub Actions minutes used this month, and re-runs the runs that failed for lack of minutes.
//
// No dependencies: the AWS SDK comes with the Lambda runtime; `fetch` and `crypto` come with Node.
import crypto from 'node:crypto';

const sdk = {
  ec2: () => import('@aws-sdk/client-ec2'),
  secrets: () => import('@aws-sdk/client-secrets-manager'),
  ssm: () => import('@aws-sdk/client-ssm'),
};
const GH = 'https://api.github.com';
const CAPACITY = /InsufficientInstanceCapacity|SpotMaxPriceTooLow|MaxSpotInstanceCountExceeded|InstanceLimitExceeded|Unsupported/;

/** Settings from the environment (set by the construct). Pure functions take them as a parameter for testing. */
export function config(env = process.env) {
  const label = env.LABEL || 'aws';
  return {
    label,
    onDemandLabel: env.ON_DEMAND_LABEL || `${label}-ondemand`,
    instanceTypes: (env.INSTANCE_TYPES || 'm7g.large,m6g.large,m8g.large').split(',').map((s) => s.trim()).filter(Boolean),
    thresholdMinutes: Number(env.THRESHOLD_MINUTES || 1900),
    maxInstances: Number(env.MAX_INSTANCES || 6),
    switchVariable: env.SWITCH_VARIABLE || 'RUNNER',
    billing: env.BILLING === 'user' ? 'user' : 'organization',
    runnerGroupId: Number(env.RUNNER_GROUP_ID || 1),
    maxJobMinutes: Number(env.MAX_JOB_MINUTES || 120),
    switchId: env.SWITCH_ID || 'default',
    repository: env.REPOSITORY || '',
  };
}

// ---------------------------------------------------------------- pure rules (unit tested)

/** `X-Hub-Signature-256` header of the webhook (HMAC-SHA256 of the raw body with the shared secret). */
export function validSignature(secret, body, header) {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`);
  const got = Buffer.from(header);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** A queued job asking for one of our runners? Returns `{ onDemand }` or null. */
export function runnerRequest(payload, c = config()) {
  if (payload?.action !== 'queued') return null;
  const labels = payload.workflow_job?.labels ?? [];
  if (!labels.includes('self-hosted')) return null;
  if (labels.includes(c.onDemandLabel)) return { onDemand: true };
  if (labels.includes(c.label)) return { onDemand: false };
  return null;
}

/** New position of the switch, or null to keep it: `aws` at the threshold; `github` when the month resets. */
export function nextRunner(usedMinutes, current, c = config()) {
  if (usedMinutes >= c.thresholdMinutes && current !== 'aws') return 'aws';
  if (usedMinutes < c.thresholdMinutes && current === 'aws') return 'github';
  return null;
}

/** GitHub Actions minutes used in the current month (billing usage report; storage is not counted). */
export function minutesThisMonth(usage, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  return (usage?.usageItems ?? [])
    .filter((i) => i.product === 'actions' && i.unitType === 'Minutes' && String(i.date).startsWith(month))
    .reduce((t, i) => t + Number(i.quantity || 0), 0);
}

/** Launch attempts in order: Spot on every type × subnet, then on-demand. On-demand jobs skip Spot. */
export function launchPlan(onDemand, subnets, c = config()) {
  const plan = [];
  if (!onDemand) for (const type of c.instanceTypes) for (const subnet of subnets) plan.push({ type, subnet, spot: true });
  for (const type of c.instanceTypes) for (const subnet of subnets) plan.push({ type, subnet, spot: false });
  return plan;
}

/**
 * Reconciliation: machines missing per label. Each machine carries one runner that is booting, idle or busy;
 * idle = active − busy. Never exceeds the total cap.
 */
export function missingRunners({ queued, active, busy }, c = config()) {
  let room = c.maxInstances - Object.values(active).reduce((t, n) => t + n, 0);
  const out = {};
  for (const label of [c.onDemandLabel, c.label]) {
    const idle = Math.max(0, (active[label] ?? 0) - (busy[label] ?? 0));
    const need = Math.max(0, Math.min((queued[label] ?? 0) - idle, room));
    if (need > 0) { out[label] = need; room -= need; }
  }
  return out;
}

/** Boot script: runs exactly one job (JIT) and shuts down — the launch template turns shutdown into terminate. */
export function userData(jitConfig, c = config()) {
  if (!/^[A-Za-z0-9+/=]+$/.test(jitConfig)) throw new Error('invalid JIT config');
  return Buffer.from(`#!/bin/bash
shutdown -h +${c.maxJobMinutes}
cd /opt/actions-runner
sudo -u runner -H ./run.sh --jitconfig '${jitConfig}' > /var/log/actions-runner.log 2>&1 || true
shutdown -h now
`).toString('base64');
}

/** Billing usage endpoint: organization report, or the user report for personal accounts. */
export function usagePath(repository, billing) {
  const owner = repository.split('/')[0];
  return billing === 'user' ? `/users/${owner}/settings/billing/usage` : `/orgs/${owner}/settings/billing/usage`;
}

// ---------------------------------------------------------------- GitHub App

let secretCache;
async function secret() {
  if (secretCache && Date.now() - secretCache.at < 300_000) return secretCache.value;
  const { SecretsManagerClient, GetSecretValueCommand } = await sdk.secrets();
  const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ID }));
  secretCache = { at: Date.now(), value: JSON.parse(r.SecretString) };
  return secretCache.value;
}

const b64url = (b) => Buffer.from(b).toString('base64url');
function appJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey, 'base64url');
  return `${head}.${body}.${sig}`;
}

async function gh(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${GH}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'cdk-github-runner-switch' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok && res.status !== 404) throw new Error(`GitHub ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function installationToken(c) {
  const s = await secret();
  if (!s.appId || !s.privateKey) throw new Error('GitHub App not configured in the secret (appId, privateKey)');
  const jwt = appJwt(s.appId, s.privateKey);
  const inst = await gh(`/repos/${c.repository}/installation`, { token: jwt });
  if (inst.status === 404) throw new Error(`GitHub App is not installed on ${c.repository}`);
  const t = await gh(`/app/installations/${inst.json.id}/access_tokens`, { token: jwt, method: 'POST' });
  return t.json.token;
}

// ---------------------------------------------------------------- AWS

let ec2Client;
async function ec2() {
  const m = await sdk.ec2();
  ec2Client ??= new m.EC2Client({});
  return { client: ec2Client, ...m };
}

async function activeByLabel(c) {
  const { client, DescribeInstancesCommand } = await ec2();
  const r = await client.send(new DescribeInstancesCommand({
    Filters: [{ Name: 'tag:runner-switch', Values: [c.switchId] }, { Name: 'instance-state-name', Values: ['pending', 'running'] }],
  }));
  const out = {};
  for (const i of (r.Reservations ?? []).flatMap((x) => x.Instances ?? [])) {
    const label = i.Tags?.find((t) => t.Key === 'runner-label')?.Value ?? c.label;
    out[label] = (out[label] ?? 0) + 1;
  }
  return out;
}

async function launch(c, jobId, onDemand, jit) {
  const { SSMClient, GetParameterCommand } = await sdk.ssm();
  const ami = (await new SSMClient({}).send(new GetParameterCommand({ Name: process.env.AMI_PARAMETER }))).Parameter.Value;
  const { client, RunInstancesCommand } = await ec2();
  const label = onDemand ? c.onDemandLabel : c.label;
  let last;
  for (const p of launchPlan(onDemand, process.env.SUBNET_IDS.split(','), c)) {
    try {
      const r = await client.send(new RunInstancesCommand({
        MinCount: 1, MaxCount: 1, ImageId: ami, InstanceType: p.type,
        LaunchTemplate: { LaunchTemplateId: process.env.LAUNCH_TEMPLATE_ID, Version: '$Latest' },
        NetworkInterfaces: [{ DeviceIndex: 0, SubnetId: p.subnet, Groups: [process.env.SECURITY_GROUP_ID], AssociatePublicIpAddress: true, DeleteOnTermination: true }],
        UserData: userData(jit, c),
        ...(p.spot ? { InstanceMarketOptions: { MarketType: 'spot', SpotOptions: { SpotInstanceType: 'one-time', InstanceInterruptionBehavior: 'terminate' } } } : {}),
        TagSpecifications: [{
          ResourceType: 'instance',
          Tags: [
            { Key: 'Name', Value: `github-runner-${c.switchId}` }, { Key: 'runner-switch', Value: c.switchId }, { Key: 'github-job', Value: String(jobId) },
            { Key: 'market', Value: p.spot ? 'spot' : 'on-demand' }, { Key: 'runner-label', Value: label },
          ],
        }],
      }));
      const id = r.Instances?.[0]?.InstanceId;
      console.log(JSON.stringify({ launched: id, job: jobId, ...p }));
      return id;
    } catch (e) {
      last = e;
      if (!CAPACITY.test(`${e.name} ${e.message}`)) throw e;
      console.log(JSON.stringify({ unavailable: p, reason: e.name }));
    }
  }
  throw last ?? new Error('no capacity');
}

async function launchFor(c, token, jobId, onDemand) {
  const jit = await gh(`/repos/${c.repository}/actions/runners/generate-jitconfig`, {
    token, method: 'POST',
    body: {
      name: `aws-${jobId}-${Date.now().toString(36)}`, runner_group_id: c.runnerGroupId, work_folder: '_work',
      labels: ['self-hosted', 'linux', 'arm64', onDemand ? c.onDemandLabel : c.label],
    },
  });
  return launch(c, jobId, onDemand, jit.json.encoded_jit_config);
}

// ---------------------------------------------------------------- tasks

async function onWebhook(event, c) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (!validSignature((await secret()).webhookSecret, raw, headers['x-hub-signature-256'])) return { statusCode: 401, body: 'invalid signature' };
  if (headers['x-github-event'] !== 'workflow_job') return { statusCode: 204 };
  const payload = JSON.parse(raw);
  const req = runnerRequest(payload, c);
  if (!req) return { statusCode: 204 };
  const active = Object.values(await activeByLabel(c)).reduce((t, n) => t + n, 0);
  if (active >= c.maxInstances) {
    // The reconciliation launches it as soon as there is room.
    console.log(JSON.stringify({ capped: payload.workflow_job.id }));
    return { statusCode: 202, body: 'cap reached; will be reconciled' };
  }
  const id = await launchFor(c, await installationToken(c), payload.workflow_job.id, req.onDemand);
  return { statusCode: 201, body: id };
}

/** Queued jobs without a machine (lost webhook or cap reached) get one. */
export async function reconcile(c = config()) {
  const token = await installationToken(c);
  const queued = {};
  for (const status of ['queued', 'in_progress']) {
    const runs = await gh(`/repos/${c.repository}/actions/runs?status=${status}&per_page=50`, { token });
    for (const run of runs.json?.workflow_runs ?? []) {
      const jobs = await gh(`/repos/${c.repository}/actions/runs/${run.id}/jobs?per_page=100`, { token });
      for (const j of jobs.json?.jobs ?? []) {
        if (j.status !== 'queued') continue;
        const req = runnerRequest({ action: 'queued', workflow_job: j }, c);
        if (req) { const l = req.onDemand ? c.onDemandLabel : c.label; queued[l] = (queued[l] ?? 0) + 1; }
      }
    }
  }
  const runners = await gh(`/repos/${c.repository}/actions/runners?per_page=100`, { token });
  const busy = {};
  for (const r of runners.json?.runners ?? []) {
    if (!r.busy) continue;
    const names = (r.labels ?? []).map((x) => x.name);
    const l = names.includes(c.onDemandLabel) ? c.onDemandLabel : names.includes(c.label) ? c.label : null;
    if (l) busy[l] = (busy[l] ?? 0) + 1;
  }
  const active = await activeByLabel(c);
  const missing = missingRunners({ queued, active, busy }, c);
  console.log(JSON.stringify({ reconcile: { queued, active, busy, missing } }));
  for (const [label, n] of Object.entries(missing)) {
    for (let k = 0; k < n; k++) await launchFor(c, token, `reconcile-${Date.now().toString(36)}`, label === c.onDemandLabel);
  }
  return missing;
}

/** Checks the minutes used and flips the switch; when moving to AWS, re-runs the runs blocked for lack of minutes. */
export async function checkUsage(c = config(), now = new Date()) {
  const token = await installationToken(c);
  const s = await secret();
  // Personal accounts: the user billing report needs a fine-grained token with "Plan: read" (`billingToken`).
  const usage = await gh(usagePath(c.repository, c.billing), { token: s.billingToken || token });
  const used = minutesThisMonth(usage.json, now);
  const v = await gh(`/repos/${c.repository}/actions/variables/${c.switchVariable}`, { token });
  const current = v.status === 404 ? 'github' : v.json.value;
  const next = nextRunner(used, current, c);
  console.log(JSON.stringify({ usedMinutes: used, current, next }));
  if (!next) return { used, runner: current };
  if (v.status === 404) await gh(`/repos/${c.repository}/actions/variables`, { token, method: 'POST', body: { name: c.switchVariable, value: next } });
  else await gh(`/repos/${c.repository}/actions/variables/${c.switchVariable}`, { token, method: 'PATCH', body: { name: c.switchVariable, value: next } });
  if (next === 'aws') {
    const since = new Date(now.getTime() - 6 * 3600_000).toISOString();
    const runs = await gh(`/repos/${c.repository}/actions/runs?status=failure&created=>=${since}&per_page=50`, { token });
    for (const run of runs.json?.workflow_runs ?? []) {
      const jobs = await gh(`/repos/${c.repository}/actions/runs/${run.id}/jobs`, { token });
      // Without minutes GitHub does not even start the job: it fails with no step executed.
      const blocked = (jobs.json?.jobs ?? []).some((j) => j.conclusion === 'failure' && (j.steps ?? []).length === 0);
      if (blocked) await gh(`/repos/${c.repository}/actions/runs/${run.id}/rerun-failed-jobs`, { token, method: 'POST' }).catch((e) => console.log(e.message));
    }
  }
  return { used, runner: next };
}

export async function handler(event) {
  const c = config();
  if (event?.task === 'check-usage') return checkUsage(c);
  if (event?.task === 'reconcile') return reconcile(c);
  try {
    return await onWebhook(event, c);
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: 'error' };
  }
}
