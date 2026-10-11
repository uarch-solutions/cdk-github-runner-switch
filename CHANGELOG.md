# Changelog

## 0.3.0

- Machines left without a job are terminated by the reconciliation after `idleGrace` (5 min): a JIT runner is not tied
  to the job that launched it, so when that job is cancelled, or another idle runner takes it first, the machine used to
  wait until `maxJobDuration`. The runner registration is removed first (GitHub refuses it while a job runs), and
  offline registrations with no machine behind them are cleaned up.
- The function may terminate only the instances it launched (`ec2:TerminateInstances` with a `runner-switch` tag condition).
- Instances carry a `runner-name` tag.

## 0.2.1

- Fix: with an imported `secret`, the function reads it by name, so the generated permission applies (it was denied with a partial ARN).

## 0.2.0

- `secret` option: reuse an existing Secrets Manager secret with the GitHub App credentials (e.g. when migrating an existing setup).

## 0.1.1

- Published from GitHub Actions with npm Trusted Publishing (OIDC) and provenance; no npm token is stored.

## 0.1.0

- First release: `GitHubRunnerSwitch` construct. It switches between GitHub-hosted runners and EC2 Spot (arm64)
  machines by the monthly Actions minutes. It includes JIT runners (one machine per job), an on-demand label,
  reconciliation of queued jobs, re-runs of the runs blocked by the minutes, a monthly Image Builder AMI and a setup
  script for the GitHub App.
