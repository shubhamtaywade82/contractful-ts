# Releasing contractful-ts

This is the release procedure. Every release is verified end to end —
strict build, strict type-check, the full test suite, and a tarball smoke
test that installs the packed artifact into a fresh consumer project —
before anything is tagged or published.

## Current status

The package is **not yet published to the public npm registry** (verified:
`npm view contractful-ts` → 404). Everything below is wired so publishing is
either one command or fully automatic once the `NPM_TOKEN` secret exists.

## One-time setup (maintainer)

1. **npm account + 2FA.** Create an account on npmjs.com, enable 2FA, and
   `npm login` locally.
2. **Check the name.** `npm view contractful-ts` must still 404 (or be yours).
3. **Automation token.** On npmjs.com → Access Tokens → Generate New Token →
   *Automation* (bypasses 2FA prompts in CI).
4. **Add the repository secret.** GitHub repo → Settings → Secrets and
   variables → Actions → New repository secret → Name `NPM_TOKEN`, value =
   the token. From then on, pushing a `v*` tag publishes automatically.

## Every release

1. **Land the changes.** All work merged to `main`, CI green on the
   Node 18/20/22/24 matrix (build + typecheck + tests).
2. **Update the version + changelog.**
   - `package.json` → `version`
   - `CHANGELOG.md` → new section at the top
3. **Run the local gates** (same ones CI runs, plus the artifact check):

   ```bash
   npm run build       # strict tsc -> dist/
   npm run typecheck   # strict tsc over src/ AND tests/types/
   npm test            # build + full vitest suite
   ```

4. **Smoke-test the tarball** — packs the artifact, installs it into a fresh
   consumer, exercises every public export, strict-compiles a consumer file
   against the shipped `.d.ts`, runs the installed `contractful-gen` binary
   and strict-compiles its output:

   ```bash
   npm run build
   bash scripts/tarball-smoke-test.sh
   ```
5. **Commit and tag.**

   ```bash
   git commit -am "release: v0.4.0"
   git tag v0.4.0
   git push origin main --tags
   ```

6. **The Release workflow takes over** (`.github/workflows/release.yml`):
   - runs the full verification matrix on the tag;
   - creates a **draft GitHub Release** with generated notes and the packed
     `contractful-ts-<version>.tgz` attached;
   - publishes to npm **only if `NPM_TOKEN` is configured** — otherwise it
     stops at the draft release.
7. **Without the token, publish manually:**

   ```bash
   npm publish --access public
   ```

   (Upload the same tarball attached to the GitHub Release:
   `npm publish contractful-ts-<version>.tgz`.)
8. **Finalize.** Review the draft release notes on GitHub and publish the
   release. Verify: `npm view contractful-ts version` shows the new version,
   and a fresh `npm install contractful-ts` in a scratch project can import
   `contractful-ts` and run `npx contractful-gen --help`.

## What the gates actually check

| Gate | Catches |
| --- | --- |
| `npm run build` (strict `tsc`) | type errors in `src/`, broken declaration emit |
| `npm run typecheck` | same, plus the compile-time test contracts in `tests/types/` (inference regressions) |
| `npx vitest run` (355 tests) | behavior: validation, retry safety, wire formats, events runtime, codegen round-trips, the e2e ticket demo |
| tarball smoke test | packaging: `files`/`exports` completeness, the installed bin symlink, declaration resolution from the artifact, CLI execution from `node_modules/.bin` |

The tarball smoke test exists because unit tests run against source and
`dist/` in-tree — none of them execute the binary the way a consumer does
(via the `.bin` symlink), which is exactly how the "installed CLI silently
did nothing" bug shipped in 0.3.1 and was caught for 0.4.0.
