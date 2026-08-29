# Security Policy

> PromptBranch Portal publishes unlisted prompt snapshots while protecting
> provider credentials, deletion tokens, viewer integrity, and deployment
> boundaries. We welcome careful, good-faith research that helps keep those
> boundaries strong.

## Supported Versions

PromptBranch Portal is currently pre-1.0. Security fixes are provided for the
latest `0.1.x` release line.

| Version | Supported | Security updates |
| ------- | :-------: | ---------------- |
| 0.1.x   | Yes       | Active           |
| < 0.1   | No        | Not supported    |

Development branches, untagged builds, forks, and modified deployments are not
supported releases. Reports are still welcome when the same issue affects the
latest supported release or the service at `promptbranch.app`.

## Scope and Security Priorities

This policy covers the portal application, the shared publishing contract, and
the deployment material in this repository. We are especially interested in
vulnerabilities that could cause:

- Unauthorized creation, modification, deletion, enumeration, or indexing of
  shared snapshots.
- Exposure of provider credentials, share deletion tokens, report metadata, or
  other sensitive material across API, storage, logging, rendering, or cache
  boundaries.
- Authentication, authorization, secret-scanning, revocation, rate-limit, or
  request-size enforcement failures.
- Stored or reflected cross-site scripting, unsafe Markdown rendering, CSP
  bypass, SQL injection, command execution, or unintended file access.
- A proxy, container, filesystem, or network-boundary bypass in the production
  deployment.
- Supply-chain or GitHub Actions compromises affecting built or deployed portal
  artifacts.

Shared snapshots are intentionally public to anyone who possesses their
unguessable `/p/<id>` URL. A report must demonstrate a boundary crossing beyond
that public-by-link design, such as practical enumeration, unauthorized
deletion, unintended indexing, or access without possession of the link.

Severity is assessed from demonstrated exploitability, required privileges and
user interaction, affected data, deployment reachability, and impact—not from a
scanner score alone.

## Reporting a Vulnerability

**Do not open a public issue, discussion, or pull request for a suspected
vulnerability. Do not include credentials, private prompts, deletion tokens, or
personal data in public GitHub content.**

Submit one vulnerability per private report through
[GitHub Security Advisories](https://github.com/PromptBranch/promptbranch-portal/security/advisories/new).
If private reporting is unavailable, email `contact@promptbranch.app` with
`[SECURITY] PromptBranch Portal` in the subject and only the minimum evidence
needed to establish the issue.

A useful report includes:

- The affected route, component, version or commit, and deployment context.
- A concise description of the vulnerability, realistic attack scenario, and
  security impact.
- Reproduction steps and a minimal proof of concept, including prerequisite
  permissions or user interaction.
- Relevant sanitized logs, screenshots, or a suggested remediation.
- Whether the issue affects `promptbranch.app` or only a self-hosted deployment.

Remove API keys, prompt contents, personal data, access tokens, and unrelated
secrets from all submitted evidence.

## What to Expect

| Milestone | Target |
| --------- | ------ |
| Acknowledgment | Within 3 business days |
| Initial validation and severity assessment | Within 7 business days |
| Progress updates for an accepted report | At least every 7 days |
| Coordinated disclosure | After a fix or agreed mitigation is available |

If a report is declined, duplicate, or determined not to cross a security
boundary, we will provide a brief explanation. Remediation timing depends on
severity, complexity, release coordination, and risk to users.

## Coordinated Disclosure

For an accepted vulnerability, we will work with you on validation,
remediation, and a responsible disclosure timeline. When appropriate, we will
publish a GitHub Security Advisory, request a CVE, and credit the reporter.
Tell us if you prefer to remain anonymous.

Please keep the report confidential until we publish an advisory or agree in
writing that disclosure is appropriate.

## Research Guidelines and Safe Harbor

- Test only systems, snapshots, accounts, and data you own or have explicit
  permission to use.
- Use the minimum interaction necessary to demonstrate the vulnerability.
- Do not persist access, exfiltrate data, disrupt availability, perform
  high-volume automated testing, or use social engineering.
- Stop immediately if you encounter another person's data, credentials, or
  private content.
- Follow applicable law and give us reasonable time to investigate and
  remediate before disclosure.

To the extent we control the matter, research performed in good faith and in
accordance with this policy will be considered authorized, and we will not
initiate legal action against the researcher. This safe harbor cannot bind
third parties.

## Generally Out of Scope

The following are generally not eligible unless they demonstrate a concrete,
previously unknown security impact:

- Scanner output without a reproducible exploit path or meaningful impact.
- Vulnerable dependencies without evidence that the behavior is reachable.
- Guessing a snapshot identifier without a practical enumeration technique.
- Reading a snapshot after its owner intentionally shared its unlisted URL.
- Self-XSS requiring users to paste code into developer tools or a terminal.
- Social engineering, phishing, physical attacks, denial-of-service testing,
  or high-volume load testing.
- Missing best-practice headers with no demonstrated security consequence.
- Issues limited to unsupported versions, forks, or modified deployments.

These exclusions do not override a demonstrated boundary crossing, privilege
increase, sensitive-data exposure, or realistic attack chain.

## Recognition and Rewards

We appreciate responsible vulnerability research. PromptBranch does not
currently operate a paid bug-bounty program, and this policy does not promise
financial compensation.
