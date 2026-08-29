# Repository Governance

This document records the expected GitHub rulesets for the repository's
protected branches. The live GitHub configuration is authoritative, but it
should not be weaker than these expectations.

## Protected Branches

`main` and `dev` are protected branches. Changes should arrive through pull
requests rather than direct pushes.

Each protected branch should require:

- At least one approving review before merge.
- Approval from a matching owner in `.github/CODEOWNERS` when a pull request
  changes repository control-plane files.
- Dismissal of stale approvals when new commits are pushed.
- Resolution of review conversations before merge.
- The GitHub Actions `verify` status check to pass on the current commit.
- Branches to be up to date before merge when GitHub can enforce that without
  blocking the repository's merge queue.
- Force pushes and branch deletion to remain disabled.

Administrators should follow the same pull-request and status-check controls
for routine changes. Emergency bypasses should be limited to repository owners,
used only to restore service or repair broken protections, and followed by a
documented review.

## Repository Control Plane

The `.github/` directory, security policy, governance policy, and ownership
rules define trusted automation and reporting boundaries. Changes to these
files require explicit review from `@NightRang3r`.

GitHub Actions must retain least-privilege token permissions. Third-party
actions must be pinned to full commit SHAs with their reviewed release versions
recorded in comments. Pull-request workflows must not use privileged triggers
such as `pull_request_target` to execute contributor-controlled code.

## Verification

Repository owners should periodically compare the live rulesets, allowed-action
policy, fork-workflow settings, installed GitHub Apps, environments, and secret
configuration with this document. Local workflow audits cannot observe those
external settings.
