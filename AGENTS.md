# AGENTS.md

## The rule: this is OSS — no one-person setups, no personal information

> 日本語要約: このリポジトリは OSS なので、特定の個人の環境に最適化した実装を書かず、個人情報をリポジトリに入れない（2026-11-11 オーナー決定）。

Owner's rule (2026-11-11). Every change must work for any user on their own machine, and nothing in the tree may identify the owner, their machines, or the people and organizations they work with. This applies to code, tests, fixtures, docs, comments, bench results, commit messages, and PR text.

Never commit:

- IP addresses, Tailscale hostnames, MagicDNS names, or tailnet names. Use `machine.tailXXXX.ts.net`, `100.64.0.0/10`, or `example.com`-style placeholders.
- Ports, paths, or binaries that only make sense on one machine. Ports that are part of the design are fine as configurable defaults.
- Usernames, absolute home-directory paths, machine names, or device names. Use `~` or `$HOME`.
- Real names, emails, phone numbers, or addresses. Use `you@example.com`.
- Company, client, or project names, and real Grok Bot names.
- Real conversation text, screenshots, recordings, or saved page HTML. Write synthetic fixtures with placeholder names instead.
- Values derived from any of the above, such as hashes of a private prompt in a file name.

Instead:

- Make anything environment-specific configurable (environment variable or flag) with a generic default, and document it in the README's variable table or the relevant `docs/` / `asr/` page.
- Discover the environment at run time (`$HOME`, `PATH`, `command -v`) rather than hardcoding it.
- Commit with a GitHub noreply address (`<id>+<user>@users.noreply.github.com`), never a personal or work email.
- Keep [`g2/src/personal-data.test.ts`](g2/src/personal-data.test.ts) passing. It scans the tree for home paths, emails, tailnet names and addresses, hashed banned names, phone numbers, tokens, and tracked media. Do not weaken it or add allowlist entries to get a change through; fix the change.

## Distribution: each user's own Beta build, never a public listing

This project is not published on Even Hub as a public listing, and there is no shared relay. Each user builds the G2 app, uploads it to their own Even Hub developer account as a Beta (private test) build, and points it at their own relay on their own Mac.

- Do not add a public or official Even Hub listing flow, store submission or review steps, a shared project or account, or a hosted or shared relay.
- Do not bake a relay URL, token, or `package_id` into the shipped package. `g2/app.json` keeps the placeholder id and an empty whitelist; users set their own before packing and do not commit them.
- Keep the README section on uploading a Beta build to one's own account and [.agents/skills/evenhub-deploy/](.agents/skills/evenhub-deploy/SKILL.md) consistent with this.

## Verify

```bash
pnpm test
pnpm run typecheck
```

Both must pass before a commit.

## Docs

- [README.md](README.md): setup, configuration variables, verification, known limits.
- [asr/README.md](asr/README.md): the local speech-recognition server and its benchmarks.
- [docs/](docs/): plan, decision log (`decisions.tsv`), and Even Hub research.
- [.agents/skills/](.agents/skills/): agent skills, e.g. Even Hub deployment.
