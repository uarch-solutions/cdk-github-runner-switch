# Contributing

Issues and pull requests are welcome.

```bash
npm ci
npm run build
npm test
```

- The control function (`lambda/index.mjs`) has no dependencies. Keep it that way: its pure rules are exported and
  unit tested in `test/lambda.test.ts`.
- Construct changes need a test in `test/construct.test.ts` (CloudFormation assertions).
- Describe the user-visible change in `CHANGELOG.md`.
