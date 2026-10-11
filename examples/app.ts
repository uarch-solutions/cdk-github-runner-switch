import { App, CfnOutput, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { GitHubRunnerSwitch } from 'cdk-github-runner-switch';

const app = new App();
const stack = new Stack(app, 'GitHubRunners', { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION } });

// Public subnets only: the machines reach GitHub directly (no NAT gateway to pay for) and have no inbound port.
const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 3, natGateways: 0, subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }] });

const runners = new GitHubRunnerSwitch(stack, 'Runners', {
  vpc,
  repository: 'my-org/my-repo',
  // Optional: warm images for `services:` and extra tooling baked into the monthly image.
  cachedImages: ['public.ecr.aws/docker/library/postgres:16-alpine'],
  extraImageCommands: ['npx -y playwright install-deps chromium'],
});

new CfnOutput(stack, 'WebhookUrl', { value: runners.webhookUrl });
new CfnOutput(stack, 'SecretArn', { value: runners.secret.secretArn });
new CfnOutput(stack, 'ImagePipelineArn', { value: runners.imagePipelineArn });
