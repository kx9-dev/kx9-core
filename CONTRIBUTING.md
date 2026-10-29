# Contributing to KX-9

Thank you for contributing. All contributions must be original or compatible
with the MIT license. This project does not fabricate contributor statistics,
past commits or mainnet activity.

## Workflow
1. Open an issue describing the problem, expected behavior and affected version.
   Report security vulnerabilities privately to **dev@kx9.tech** instead.
2. Create a branch from `main`. Keep changes focused and explain the tradeoffs.
3. Install the pinned dependencies and run the checks documented in README.
4. Add regression tests for changed behavior, including authorization and failure
   cases. Use synthetic local test fixtures, never production customer data.
5. Submit a pull request using the template. Document API/schema changes and
   breaking changes. A maintainer reviews before merging.

## Required boundaries
- Never commit real secrets, databases, logs, private provider URLs or signed
  execution recovery records. Use blank examples and environment variables.
- Never label simulated data, submitted transactions or missing measurements
  as confirmed mainnet results.
- Keep wallet resources owner-scoped and error messages sanitized.
- Do not deploy contracts, enable spending or move funds through a contribution.
- Use UTC for time-related documentation and interfaces.
- Preserve the landing at kx9.tech and the app at app.kx9.tech.

## Reviews and releases
Use descriptive, truthful commits; do not backdate or manufacture contributions.
Releases must match a real reviewed commit and contain checksummed packages.
Follow semantic versioning; document limitations and migration steps.
