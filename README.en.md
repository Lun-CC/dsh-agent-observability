# dsh-audit

Session cost audit for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
**conclusions and executable prescriptions, not a timeline.**

> Not "what did the agent do" — "which step burned money, and what do I change?"

| Mode | Entry | Extras |
|---|---|---|
| Offline CLI | `dsh-audit` (ships with the npm package since 1.0.0) | events, provider usage, char-estimated tool-result volume |
| In-host plugin | npm `dsh-audit-plugin` (mount id `dsh-cost-audit`) | per-node token attribution priced by the platform, plus a Web report page with one-click fixes |

Version **1.0.0** (2026-10-22, first public release). Node `^22.19.0 || >=24`,
DSH `engines.dsh >=0.2.0-rc.2`. Chinese docs: [`README.md`](README.md).
Release notes: [`docs/release/2026-10-22-v1.0.0.md`](docs/release/2026-10-22-v1.0.0.md).
Repository: <https://github.com/Lun-CC/dsh-agent-observability>.

## Why different

Timeline viewers (e.g. `lamost423/dsh-maze`) show what happened. We show the step that
produced nothing, its cost, and the exact edit: one config line, three facts in
`AGENTS.md`, or a button on the report page.

Not the same as npm `dsh-audit` (ecosystem health checks): ours audits session cost; mount
id `dsh-cost-audit`.

## Install

```bash
dsh plugin --profile web add dsh-audit-plugin
```

Bundle package (`dsh.bundle.patch`); `dsh plugin add` writes `dependencies` and
`dsh.profile.bundles`, enabled at once. Don't hand-insert a leaf plugin (runs but invisible
in the plugin page). Local dev: `file:<absolute-path>`, not `link:`.

The package ships `bin/dsh-audit.mjs`, so install also gives you the offline `dsh-audit`
CLI (entry: profile `node_modules/.bin/dsh-audit`; see [Usage](#usage-cli)). On Windows
PowerShell the env var is `$env:DSH_HOME`.

Upgrade: `dsh plugin --profile web add dsh-audit-plugin@latest`. Reports older than 0.8.0
are `.txt` only; backfill `.json` for the Web UI with `node scripts/backfill-summaries.mjs`.

## After install

- Plugins page → `dsh-audit-plugin`, enabled by default; "¥ 成本报告" (bottom-right) opens
  `http://127.0.0.1:<dsh-port>/dsh-cost-audit/`
- Page: number cards → verdict → prescription cards, full report in `<details>`; subagents
  folded into their parent; self-contained, no CDN
- Every `session/flush` audits automatically (first report after the first turn)

```
$DSH_HOME/dsh-audit/latest.txt|.json        latest top-level session (Web UI reads .json)
$DSH_HOME/dsh-audit/report-<sessionId>.txt|.json   per session (subagents too)
$DSH_HOME/dsh-audit/errors.log              only on errors
$DSH_HOME/dsh-audit/debug-snapshot.json     only with debugShape: true
```

`latest.*` is written only by top-level sessions, so a subagent never overwrites it.
Retention: 200 reports / 7 days (configurable); `errors.log` rotates at 256 KiB.

## Usage (CLI)

No DSH, API key or network — reads persisted logs only. `dsh-audit` below means the
profile entry (`node_modules/.bin/dsh-audit`) or the `npx --yes --package=dsh-audit-plugin --`
prefix; repo checkout: `node bin/dsh-audit.mjs`.

```bash
dsh-audit ~/.dsh/sessions/--E-aibuild--/session-xxxx   # one session directory
dsh-audit ~/.dsh/sessions                              # all sessions (overview)
dsh-audit ~/.dsh/sessions --json                       # machine-readable
dsh-audit ~/.dsh/sessions --tool-limit=5               # top N tools in the report
dsh-audit --help                                       # usage / options / exit codes
dsh-audit --version                                    # 1.0.0
```

Flags: `<session dir | .jsonl.zstd file>`, `--json`, `--tool-limit=<N>` / `--tool-limit N`
(top N tools, default 10), `-h/--help`, `-V/--version`; unknown options error. Exit codes:
`0` ≥1 session ok, `1` all failed, `2` bad args (missing target / path not found / bad value).

## Fixes

"Apply this fix" previews target + block, writes with backup `<file>.bak-<timestamp>`, is
idempotent, and can be reverted from the same button; config edits apply after a DSH
restart. CLI: `node scripts/apply-fix.mjs --list|--id=spill|--revert`.

Targets: `cordis.patch.yml` (enable `tool-result-pruner`; set
`spill-policy.maxInlineTokens: 3000` — **no effect on `read`**) or project `AGENTS.md`
(reading conventions, environment facts).

## Configuration

In the profile's `cordis.patch.yml` (`$DSH_HOME/profiles/<profile>`); verify with
`dsh --profile web --dump-config`.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | no-op when false |
| `autoReport` | `true` | audit on every `session/flush` |
| `minIntervalMs` | `3000` | per-session debounce |
| `outDir` | `$DSH_HOME/dsh-audit` | output dir (`null` = default) |
| `maxReports` | `200` | keep at most N reports |
| `maxAgeDays` | `7` | drop reports older than N days |
| `maxErrorLogBytes` | `262144` | rotate `errors.log` above 256 KiB |
| `debugShape` | `false` | dump first event `data` (privacy risk) |
| `debugTriggers` | `false` | log trigger reasons |
| `ui` | `true` | serve Web page + entry button |

## Privacy

Reports contain session id, cwd, event labels, tool names, token counts, and tool-call
sequence numbers from prescriptions — no prompts, tool-result bodies, or system prompts.
`debugShape: true` dumps the first event's full `data` (possibly prompt text): use briefly,
then delete. `errors.log` may contain stack traces with file paths. No network; data stays local.

## Compatibility

| Item | Requirement |
|---|---|
| Node | `^22.19.0 || >=24` |
| DSH | `>=0.2.0-rc.2` (verified on 0.2.0-rc.2 / 0.2.1-rc.2) |
| Required service | `sessionQuery` |
| Optional service | `tokenMeter` (developer preview; read via `ctx.get`) |
| Package form | bundle (`dsh.bundle.patch` + `manifestVersion: 1`) |

## Known limitations

- Billing totals: `assistant/message.data.usage`; `measure().totalTokens` is **not a bill**
  (measured 10,729 vs 2,512).
- `read` is exempt from `spill-policy`; lowering `maxInlineTokens` saves nothing for it.
- Compaction-pruned nodes still count toward carry cost.
- No per-plugin schema attribution (`ctx.tools.register()` exposes no registrar).
- Char-based estimates (CJK ≈ 1 token/char) overestimate Chinese ~10–20%.
- Barren steps: only steps where every tool call failed.
- Empty/interrupted sessions yield no prescriptions; missing `tokenMeter` only hides
  platform pricing (reports still work).
- Each flush re-analyzes the whole session (sync CPU); no `Config`, no settings panel.

## Uninstall

```bash
dsh plugin --profile web remove dsh-audit-plugin
rm -rf "$DSH_HOME/dsh-audit"   # data dir is not removed automatically
```

## License

MIT. See [`LICENSE`](LICENSE).
