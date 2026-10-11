# Changelog

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
