# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Report it
privately through [GitHub's private vulnerability reporting](https://github.com/fedecardinali/agent-coordinator/security/advisories/new).

Include the affected version, impact, reproduction steps, and any relevant
logs with credentials and tokens removed. Reports are acknowledged as soon as
practical and handled confidentially until a fix or mitigation is available.

If private vulnerability reporting is unavailable, open a minimal issue asking
for a private contact channel without including vulnerability details.

## Scope

The project is especially sensitive to credential leakage, unsafe path or
symlink handling, unintended Git mutation, and generated files overwriting
user-owned files. Please report those issues even when the impact is not yet
fully understood.
