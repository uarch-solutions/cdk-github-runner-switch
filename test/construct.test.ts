import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { describe, expect, it } from 'vitest';
import { BillingScope, GitHubRunnerSwitch, runnerComponent } from '../src';

const build = (props: Partial<ConstructorParameters<typeof GitHubRunnerSwitch>[2]> = {}) => {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new Stack(app, 'Ci', { env: { account: '111111111111', region: 'us-east-1' } });
  const vpc = new ec2.Vpc(stack, 'Vpc', { natGateways: 0, subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }] });
  const sw = new GitHubRunnerSwitch(stack, 'Runners', { vpc, repository: 'acme/app', ...props });
  return { sw, t: Template.fromStack(stack) };
};

describe('GitHubRunnerSwitch', () => {
  const { sw, t } = build();

  it('public Function URL for the webhook (the function checks the GitHub signature) and the two schedules', () => {
    t.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
    t.hasResourceProperties('AWS::Lambda::Function', { Architectures: ['arm64'], Handler: 'index.handler' });
    t.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(5 minutes)', Targets: Match.arrayWith([Match.objectLike({ Input: JSON.stringify({ task: 'reconcile' }) })]) });
    t.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(30 minutes)', Targets: Match.arrayWith([Match.objectLike({ Input: JSON.stringify({ task: 'check-usage' }) })]) });
    expect(sw.webhookUrl).toBeDefined();
  });

  it('defaults reach the function: labels, M-family Graviton types, 1,900 minutes, 6 machines, organization billing', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({
        REPOSITORY: 'acme/app', LABEL: 'aws', ON_DEMAND_LABEL: 'aws-ondemand', INSTANCE_TYPES: 'm7g.large,m6g.large,m8g.large',
        THRESHOLD_MINUTES: '1900', MAX_INSTANCES: '6', SWITCH_VARIABLE: 'RUNNER', BILLING: 'organization', MAX_JOB_MINUTES: '120',
      }) },
    });
  });

  it('runner machine: no inbound, IMDSv2, terminates on shutdown, encrypted disk; Session Manager only', () => {
    t.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupDescription: 'GitHub runners: no inbound', SecurityGroupIngress: Match.absent() });
    t.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        InstanceInitiatedShutdownBehavior: 'terminate',
        MetadataOptions: Match.objectLike({ HttpTokens: 'required' }),
        BlockDeviceMappings: [Match.objectLike({ Ebs: Match.objectLike({ VolumeSize: 40, Encrypted: true, DeleteOnTermination: true }) })],
      }),
    });
  });

  it('least privilege: launch, tag and list instances, pass only the runner role; terminate only its own machines', () => {
    const policies = Object.values(t.findResources('AWS::IAM::Policy')) as any[];
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    const actions = statements.flatMap((s: any) => [].concat(s.Action));
    expect(actions).toEqual(expect.arrayContaining(['ec2:RunInstances', 'ec2:CreateTags', 'ec2:DescribeInstances', 'iam:PassRole', 'ssm:GetParameter']));
    expect(actions.some((a: string) => /^ec2:\*$|^\*$/.test(a))).toBe(false);
    const terminate = statements.filter((s: any) => [].concat(s.Action).includes('ec2:TerminateInstances' as never));
    expect(terminate).toHaveLength(1);
    expect(terminate[0].Condition).toEqual({ StringEquals: { 'aws:ResourceTag/runner-switch': expect.any(String) } });
  });

  it('secret with a generated webhook secret and empty App fields', () => {
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({ GenerateStringKey: 'webhookSecret', SecretStringTemplate: JSON.stringify({ appId: '', privateKey: '' }) }),
    });
  });

  it('image: Canonical Ubuntu 24.04 arm64, scheduled rebuild, AMI published under /imagebuilder/', () => {
    t.hasResourceProperties('AWS::ImageBuilder::ImageRecipe', { ParentImage: Match.stringLikeRegexp('^ssm:/aws/service/canonical/ubuntu/server/24.04/.*/arm64/') });
    t.hasResourceProperties('AWS::ImageBuilder::ImagePipeline', { Schedule: Match.objectLike({ ScheduleExpression: 'cron(0 5 1 * ? *)' }) });
    expect(sw.amiParameterName).toMatch(/^\/imagebuilder\/[a-z0-9-]+\/ami$/);
    t.hasResourceProperties('AWS::ImageBuilder::DistributionConfiguration', {
      Distributions: [Match.objectLike({ SsmParameterConfigurations: [{ ParameterName: sw.amiParameterName, DataType: 'aws:ec2:image' }] })],
    });
  });

  it('options: labels, instance types, limits, user billing, job timeout and disk', () => {
    const { t: custom } = build({
      label: 'spot', onDemandLabel: 'deploy', instanceTypes: ['c7g.xlarge'], thresholdMinutes: 2900, maxInstances: 3,
      billing: BillingScope.USER, maxJobDuration: Duration.minutes(45), rootVolumeSize: 60, switchVariable: 'CI_RUNNER',
    });
    custom.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({
        LABEL: 'spot', ON_DEMAND_LABEL: 'deploy', INSTANCE_TYPES: 'c7g.xlarge', THRESHOLD_MINUTES: '2900', MAX_INSTANCES: '3', BILLING: 'user',
        MAX_JOB_MINUTES: '45', SWITCH_VARIABLE: 'CI_RUNNER',
      }) },
    });
    custom.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({ BlockDeviceMappings: [Match.objectLike({ Ebs: Match.objectLike({ VolumeSize: 60 }) })] }),
    });
  });

  it('can reuse an existing secret (no new secret is created)', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new Stack(app, 'Ci', { env: { account: '111111111111', region: 'us-east-1' } });
    const vpc = new ec2.Vpc(stack, 'Vpc', { natGateways: 0, subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }] });
    const existing = secretsmanager.Secret.fromSecretNameV2(stack, 'Existing', 'ci/github-app');
    new GitHubRunnerSwitch(stack, 'Runners', { vpc, repository: 'acme/app', secret: existing });
    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs('AWS::SecretsManager::Secret', 0);
    const fn = Object.values(tpl.findResources('AWS::Lambda::Function'))[0] as any;
    // By name, so the generated grant (full ARN with the random suffix) applies.
    expect(fn.Properties.Environment.Variables.SECRET_ID).toBe('ci/github-app');
  });

  it('rejects a repository that is not owner/name', () => {
    expect(() => build({ repository: 'just-a-name' })).toThrow(/owner\/name/);
  });

  it('component version follows its content (Image Builder components are immutable)', () => {
    const version = (tpl: Template) => (Object.values(tpl.findResources('AWS::ImageBuilder::Component'))[0] as any).Properties.Version;
    expect(version(build().t)).toBe(version(t));
    expect(version(build({ cachedImages: ['postgres:16'] }).t)).not.toBe(version(t));
  });
});

describe('runner image component', () => {
  it('step names use only letters, digits, - and _ (Image Builder rule); optional steps only when asked', () => {
    const plain = runnerComponent({ nodeMajorVersion: 24, cachedImages: [], extraCommands: [] });
    const full = runnerComponent({ nodeMajorVersion: 22, cachedImages: ['public.ecr.aws/docker/library/postgres:16-alpine'], extraCommands: ['echo "hi"'] });
    for (const data of [plain, full]) {
      for (const n of [...data.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1]!.trim())) expect(n).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(plain).not.toContain('CachedImages');
    expect(full).toContain('setup_22.x');
    expect(full).toContain('"docker pull public.ecr.aws/docker/library/postgres:16-alpine"');
    expect(full).toContain('"echo \\"hi\\""');
  });
});
