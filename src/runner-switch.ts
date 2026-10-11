import * as crypto from 'crypto';
import * as path from 'path';
import { Duration, Names, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/** Where the GitHub Actions minutes are counted. */
export enum BillingScope {
  /** Organization billing report (`/orgs/{org}/settings/billing/usage`), read with the GitHub App token. */
  ORGANIZATION = 'organization',
  /** Personal account billing report; needs a fine-grained token with "Plan: read" stored as `billingToken`. */
  USER = 'user',
}

export interface GitHubRunnerSwitchProps {
  /** VPC for the runner machines. They need outbound internet access; by default they use public subnets (no NAT). */
  readonly vpc: ec2.IVpc;
  /** @default - public subnets */
  readonly subnets?: ec2.SubnetSelection;
  /** Repository served by the runners, as `owner/name`. */
  readonly repository: string;
  /** @default BillingScope.ORGANIZATION */
  readonly billing?: BillingScope;
  /** Label of the Spot runners (`runs-on: [self-hosted, linux, arm64, <label>]`). @default 'aws' */
  readonly label?: string;
  /** Label of the on-demand runners (e.g. deploy jobs that must not be interrupted). @default `${label}-ondemand` */
  readonly onDemandLabel?: string;
  /** Graviton (arm64) instance types, in order of preference. @default ['m7g.large', 'm6g.large', 'm8g.large'] */
  readonly instanceTypes?: string[];
  /** Minutes used this month at which the switch moves to AWS. @default 1900 (free plan: 2,000) */
  readonly thresholdMinutes?: number;
  /** Maximum machines at the same time. @default 6 */
  readonly maxInstances?: number;
  /** Repository variable flipped between `github` and `aws`. @default 'RUNNER' */
  readonly switchVariable?: string;
  /** Runner group of the JIT registrations. @default 1 (Default) */
  readonly runnerGroupId?: number;
  /** Safety net: the machine shuts down after this long even if the job hangs. @default Duration.hours(2) */
  readonly maxJobDuration?: Duration;
  /** Root disk in GiB. @default 40 */
  readonly rootVolumeSize?: number;
  /** Node.js major version installed in the image. @default 24 */
  readonly nodeMajorVersion?: number;
  /** Container images pulled into the image ahead of time (faster `services:`). @default [] */
  readonly cachedImages?: string[];
  /** Extra shell commands run as root while building the image (e.g. `npx -y playwright install-deps chromium`). @default [] */
  readonly extraImageCommands?: string[];
  /** When the image is rebuilt (EventBridge cron, UTC). @default 'cron(0 5 1 * ? *)' — monthly, day 1 at 05:00 */
  readonly imageSchedule?: string;
  /**
   * Existing secret with `webhookSecret`, `appId` and `privateKey` (and `billingToken` for personal accounts), e.g. when
   * migrating an existing setup. @default - a new secret with a generated `webhookSecret`
   */
  readonly secret?: secretsmanager.ISecret;
  /** @default Duration.minutes(5) */
  readonly reconcileInterval?: Duration;
  /** @default Duration.minutes(30) */
  readonly usageCheckInterval?: Duration;
}

/**
 * GitHub Actions runners that switch between GitHub-hosted (free minutes) and disposable EC2 Spot machines on AWS when
 * the monthly minutes run out, and back when the month resets.
 *
 * - A GitHub App sends `workflow_job` webhooks to a Lambda Function URL; each queued job gets its own machine with a
 *   single-use (JIT) runner registration. The machine terminates when the job ends.
 * - The Lambda flips a repository variable (`RUNNER`) by the minutes used; workflows pick the runner with
 *   `runs-on: ${{ vars.RUNNER == 'aws' && fromJSON('["self-hosted","linux","arm64","aws"]') || 'ubuntu-24.04-arm' }}`.
 * - An EC2 Image Builder pipeline rebuilds the Ubuntu 24.04 arm64 image on a schedule.
 */
export class GitHubRunnerSwitch extends Construct {
  /** URL to configure as the GitHub App webhook. */
  public readonly webhookUrl: string;
  /** Secret holding `webhookSecret` (generated), `appId` and `privateKey` (filled by the setup script). */
  public readonly secret: secretsmanager.ISecret;
  /** SSM parameter with the current runner AMI (written by Image Builder). */
  public readonly amiParameterName: string;
  /** Image Builder pipeline: run it once after the first deploy. */
  public readonly imagePipelineArn: string;
  /** The control function (webhook, reconciliation and usage check). */
  public readonly function: lambda.IFunction;
  /** Security group of the runner machines (no inbound rules). */
  public readonly securityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: GitHubRunnerSwitchProps) {
    super(scope, id);
    if (!/^[\w.-]+\/[\w.-]+$/.test(props.repository)) throw new Error(`repository must be "owner/name", got "${props.repository}"`);
    const name = Names.uniqueResourceName(this, { maxLength: 48, separator: '-' }).toLowerCase();
    const label = props.label ?? 'aws';
    const onDemandLabel = props.onDemandLabel ?? `${label}-ondemand`;
    const instanceTypes = props.instanceTypes ?? ['m7g.large', 'm6g.large', 'm8g.large'];
    if (!instanceTypes.length) throw new Error('instanceTypes must not be empty');
    const rootVolumeSize = props.rootVolumeSize ?? 40;
    // Image Builder can only write SSM parameters under /imagebuilder/ (its service role).
    this.amiParameterName = `/imagebuilder/${name}/ami`;
    const subnets = props.vpc.selectSubnets(props.subnets ?? { subnetType: ec2.SubnetType.PUBLIC });

    // Runner machine: no inbound port, outbound only.
    const sg = new ec2.SecurityGroup(this, 'RunnerSecurityGroup', { vpc: props.vpc, description: 'GitHub runners: no inbound', allowAllOutbound: true });
    this.securityGroup = sg;
    const instanceRole = new iam.Role(this, 'RunnerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'GitHub runner machine: Session Manager access only (jobs use their own OIDC role)',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    const template = new ec2.LaunchTemplate(this, 'RunnerTemplate', {
      role: instanceRole,
      instanceInitiatedShutdownBehavior: ec2.InstanceInitiatedShutdownBehavior.TERMINATE,
      requireImdsv2: true,
      blockDevices: [{
        deviceName: '/dev/sda1',
        volume: ec2.BlockDeviceVolume.ebs(rootVolumeSize, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true, deleteOnTermination: true }),
      }],
    });

    // Image: Canonical Ubuntu 24.04 arm64 + runner tooling. Components are immutable, so the version follows the content.
    const componentData = runnerComponent({
      nodeMajorVersion: props.nodeMajorVersion ?? 24, cachedImages: props.cachedImages ?? [], extraCommands: props.extraImageCommands ?? [],
    });
    const version = `1.0.${parseInt(crypto.createHash('sha256').update(componentData).digest('hex').slice(0, 7), 16) % 1_000_000}`;
    const builderRole = new iam.Role(this, 'ImageBuilderRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
      ],
    });
    const builderProfile = new iam.CfnInstanceProfile(this, 'ImageBuilderProfile', { roles: [builderRole.roleName] });
    const component = new imagebuilder.CfnComponent(this, 'RunnerComponent', { name, platform: 'Linux', version, data: componentData });
    const recipe = new imagebuilder.CfnImageRecipe(this, 'RunnerRecipe', {
      name, version,
      parentImage: 'ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id',
      components: [{ componentArn: component.attrArn }],
      blockDeviceMappings: [{ deviceName: '/dev/sda1', ebs: { volumeSize: rootVolumeSize, volumeType: 'gp3', deleteOnTermination: true } }],
    });
    const infra = new imagebuilder.CfnInfrastructureConfiguration(this, 'RunnerBuildInfrastructure', {
      name, instanceProfileName: builderProfile.ref, instanceTypes: instanceTypes.slice(0, 2),
      subnetId: subnets.subnetIds[0], securityGroupIds: [sg.securityGroupId], terminateInstanceOnFailure: true,
    });
    const distribution = new imagebuilder.CfnDistributionConfiguration(this, 'RunnerDistribution', {
      name,
      distributions: [{
        region: Stack.of(this).region,
        amiDistributionConfiguration: { Name: `${name}-{{ imagebuilder:buildDate }}` },
        ssmParameterConfigurations: [{ parameterName: this.amiParameterName, dataType: 'aws:ec2:image' }],
      }],
    });
    const pipeline = new imagebuilder.CfnImagePipeline(this, 'RunnerImagePipeline', {
      name,
      imageRecipeArn: recipe.attrArn, infrastructureConfigurationArn: infra.attrArn, distributionConfigurationArn: distribution.attrArn,
      schedule: { scheduleExpression: props.imageSchedule ?? 'cron(0 5 1 * ? *)', pipelineExecutionStartCondition: 'EXPRESSION_MATCH_ONLY' },
      imageTestsConfiguration: { imageTestsEnabled: false },
    });
    this.imagePipelineArn = pipeline.attrArn;

    // GitHub App credentials: the webhook secret is generated here; the setup script adds appId and privateKey.
    const secret = props.secret ?? new secretsmanager.Secret(this, 'AppSecret', {
      description: `GitHub App of the runners for ${props.repository} (cdk-github-runner-switch)`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ appId: '', privateKey: '' }),
        generateStringKey: 'webhookSecret', excludePunctuation: true, passwordLength: 40,
      },
    });
    this.secret = secret;

    const fn = new lambda.Function(this, 'Control', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      timeout: Duration.seconds(60),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'ControlLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      description: `GitHub runner switch for ${props.repository}: webhook, reconciliation and minutes check`,
      environment: {
        // An imported secret is read by name: its grant covers the full ARN (with the random suffix), not a partial ARN.
        SECRET_ID: props.secret ? props.secret.secretName : secret.secretArn,
        REPOSITORY: props.repository,
        BILLING: props.billing ?? BillingScope.ORGANIZATION,
        LABEL: label,
        ON_DEMAND_LABEL: onDemandLabel,
        INSTANCE_TYPES: instanceTypes.join(','),
        THRESHOLD_MINUTES: String(props.thresholdMinutes ?? 1900),
        MAX_INSTANCES: String(props.maxInstances ?? 6),
        SWITCH_VARIABLE: props.switchVariable ?? 'RUNNER',
        RUNNER_GROUP_ID: String(props.runnerGroupId ?? 1),
        MAX_JOB_MINUTES: String((props.maxJobDuration ?? Duration.hours(2)).toMinutes()),
        SWITCH_ID: name,
        AMI_PARAMETER: this.amiParameterName,
        LAUNCH_TEMPLATE_ID: template.launchTemplateId!,
        SECURITY_GROUP_ID: sg.securityGroupId,
        SUBNET_IDS: subnets.subnetIds.join(','),
      },
    });
    this.function = fn;
    secret.grantRead(fn);
    const { region, account } = Stack.of(this);
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:aws:ssm:${region}:${account}:parameter${this.amiParameterName}`] }));
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:RunInstances', 'ec2:CreateTags', 'ec2:DescribeInstances'], resources: ['*'] }));
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [instanceRole.roleArn] }));
    this.webhookUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE }).url;

    new events.Rule(this, 'UsageCheck', {
      schedule: events.Schedule.rate(props.usageCheckInterval ?? Duration.minutes(30)),
      targets: [new targets.LambdaFunction(fn, { event: events.RuleTargetInput.fromObject({ task: 'check-usage' }), retryAttempts: 1 })],
    });
    new events.Rule(this, 'Reconcile', {
      schedule: events.Schedule.rate(props.reconcileInterval ?? Duration.minutes(5)),
      targets: [new targets.LambdaFunction(fn, { event: events.RuleTargetInput.fromObject({ task: 'reconcile' }), retryAttempts: 0 })],
    });
  }
}

/** Image Builder component (YAML). Step names: letters, digits, `-` and `_` only. */
export function runnerComponent(o: { nodeMajorVersion: number; cachedImages: string[]; extraCommands: string[] }): string {
  const list = (cmds: string[]) => cmds.map((c) => `            - ${JSON.stringify(c)}`).join('\n');
  const steps = [`      - name: Packages
        action: ExecuteBash
        inputs:
          commands:
${list([
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update',
    'apt-get install -y ca-certificates curl git jq unzip zip build-essential python3 python3-pip docker.io',
    'systemctl enable docker',
    `curl -fsSL https://deb.nodesource.com/setup_${o.nodeMajorVersion}.x | bash -`,
    'apt-get install -y nodejs',
    'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg',
    'echo "deb [arch=arm64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
    'apt-get update && apt-get install -y gh',
    'curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o /tmp/awscli.zip && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip',
  ])}`, `      - name: Runner
        action: ExecuteBash
        inputs:
          commands:
${list([
    'id runner || useradd -m -s /bin/bash runner',
    'usermod -aG docker runner',
    'echo "runner ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runner && chmod 440 /etc/sudoers.d/runner',
    'V=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed "s/^v//")',
    'mkdir -p /opt/actions-runner && cd /opt/actions-runner && curl -fsSL "https://github.com/actions/runner/releases/download/v$V/actions-runner-linux-arm64-$V.tar.gz" | tar xz',
    '/opt/actions-runner/bin/installdependencies.sh',
    'chown -R runner:runner /opt/actions-runner',
  ])}`];
  if (o.cachedImages.length) steps.push(`      - name: CachedImages
        action: ExecuteBash
        inputs:
          commands:
${list(o.cachedImages.map((i) => `docker pull ${i}`))}`);
  if (o.extraCommands.length) steps.push(`      - name: Extra
        action: ExecuteBash
        inputs:
          commands:
${list(o.extraCommands)}`);
  return `name: github-runner
description: GitHub Actions runner (cdk-github-runner-switch)
schemaVersion: 1.0
phases:
  - name: build
    steps:
${steps.join('\n')}
`;
}
