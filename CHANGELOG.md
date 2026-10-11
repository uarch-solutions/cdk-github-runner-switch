# Changelog

## 0.1.0

- First release: `GitHubRunnerSwitch` construct. It switches between GitHub-hosted runners and EC2 Spot (arm64)
  machines by the monthly Actions minutes. It includes JIT runners (one machine per job), an on-demand label,
  reconciliation of queued jobs, re-runs of the runs blocked by the minutes, a monthly Image Builder AMI and a setup
  script for the GitHub App.
