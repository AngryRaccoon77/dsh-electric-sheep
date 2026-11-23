# dsh-electric-sheep

English | [中文](README.zh.md)

## Summary

Add one daily reflective Session to a DeepSeek Harness profile. Once a day, or on `/sleep`, one isolated Session reviews the Sessions that were active since the last sleep and rewrites the notes under `$DSH_HOME/sleep/`. Every later working Session starts with those notes in a `<system-reminder>` block.

The sleep Session runs under its own `sleep` preset. The preset mounts no agent instructions and no project tools, and the Session sees seven sleep tools only.

## Table of Contents

- [Requirements](#requirements)
- [Install](#install)
- [What you get](#what-you-get)
- [Configuration](#configuration)
- [The `/sleep` command](#the-sleep-command)
- [Where the notes live](#where-the-notes-live)
- [Known Limitations](#known-limitations)
- [Links](#links)

-----

<a id="requirements"></a>
## Requirements

- DeepSeek Harness `0.2.3-alpha.2` or newer. The package declares this minimum in `engines.dsh`.
- A profile that composes a storage provider, the Session query service, and, for `/sleep`, a command registry. The standard `web` and `headless` profiles do.
- The `@deepseek-ai/*` packages the built JavaScript imports are peers of this package. Every DSH installation provides them, so an install needs no separate download.

The two rows in `cordis.patch.yml` also name `@deepseek-ai/dsh-agent-preset`, `@deepseek-ai/dsh-persona`, and `@deepseek-ai/dsh-compaction-basic`. The DSH installation provides those packages too.

<a id="install"></a>
## Install

Install the package into a profile:

```sh
dsh plugin --profile web add https://github.com/AngryRaccoon77/dsh-electric-sheep
```

Then enable the bundle. In Web, open **Plugins** in the sidebar and select **Enable now**. Alternatively, add `"dsh-electric-sheep"` to `dsh.profile.bundles` in the profile `package.json`. With HMR enabled, the selection applies at once. Otherwise, restart the application.

Install one fixed commit:

```sh
dsh plugin --profile web add "https://github.com/AngryRaccoon77/dsh-electric-sheep#<commit>"
```

Replace `<commit>` with a full 40-character commit sha. The plugin manager identifies a Git bundle by the commit it pins, so a pinned install does not move to a newer commit on its own.

Remove the plugin in **Plugins → dsh-electric-sheep → Remove**, or with `dsh plugin --profile web remove dsh-electric-sheep`.

<a id="what-you-get"></a>
## What you get

[`cordis.patch.yml`](cordis.patch.yml) inserts two rows.

| Row | What it adds |
|---|---|
| `sleep` | The host runtime, published as `ctx.sleep`, with `config`, `state`, `stateError`, `activeSessionId`, `activeRun`, `nextSlot()`, `startNow()` and `runNow()` |
| `preset-sleep` | The `sleep` agent preset: a `@deepseek-ai/dsh-persona` prefix, the isolation row that masks inherited Host tools, and an isolated `@deepseek-ai/dsh-compaction-basic` |

- The runtime runs at most one sleep attempt at a time, by schedule or on demand.
- The slot comes from `time` in `timeZone`. A slot that passed while the Host was down runs once after startup, and a local date that already holds a scheduled decision never runs again.
- A scheduled run needs at least `minSessions` non-sleep Sessions with activity after the last completed sleep. A day with nothing to review records its date and creates no Session.
- The sleep Session is created outside any initiating Agent, is named `Sleep · <local date>`, and receives `reasoningEffort` before its first request. The runtime answers that effort against the routed model: a model that declares the level gets it, a model with another default gets that default, and a model that declares no effort keeps its adapter default. Every downgrade is logged. Working Sessions keep the user's own model selection.
- One `agent/pre-step` guard keeps workspace instructions out of every sleep Session, so the isolation holds whether the profile mounts `dsh-agent-instructions` as a preset row or as a Host row.
- One `agent/pre-step` listener reloads the saved notes into every working Session.

<a id="configuration"></a>
## Configuration

The `sleep` row carries these fields. The shipped patch sets every default shown here, and the patch `config` block is the place to change one.

| Field | Default | Meaning |
|---|---|---|
| `dir` | required | Directory that holds the notes; the shipped patch sets `dshHomePath('sleep')` |
| `enabled` | `true` | Whether the daily slot may start a run; `/sleep` ignores it |
| `time` | `'03:00'` | Daily slot as `HH:mm` in `timeZone` |
| `timeZone` | host zone, else `UTC` | IANA zone the slot follows |
| `minSessions` | `1` | Non-sleep Sessions active after the last sleep that a scheduled run requires; `0` always runs |
| `injectMaxBytes` | `16384` | Most bytes the notes block carries inline, each note's heading and path included |
| `maxSourceBytes` | `1048576` | Most bytes one note read returns, and most bytes one note write accepts |
| `inspectMaxBytes` | `4194304` | Most note content one injection pass reads to classify notes as text or binary |
| `inspectMaxEntries` | `1024` | Most directory entries one injection pass examines while it lists the notes tree |
| `presetId` | `'sleep'` | Preset the sleep Session mounts; it must match the `preset-sleep` row |
| `reasoningEffort` | `'max'` | Reasoning effort selected for the sleep Session model when the routed model declares it |

A configured value that breaks the contract stops the plugin at load with a coded diagnostic. An empty `dir`, a `time` that is not `HH:mm`, and a `timeZone` that is not an IANA zone all fail that way, so no run starts against a value the runtime cannot use.

<a id="the-sleep-command"></a>
## The `/sleep` command

Where the profile composes a command registry, `/sleep` answers these three invocations.

| Invocation | What it does |
|---|---|
| `/sleep` | Starts one manual run and answers with the Session that runs it |
| `/sleep now` | The same |
| `/sleep status` | Reports the schedule, the last outcome, the next slot, the active run, and the notes directory |

A manual run ignores `enabled` and `minSessions`, because the user asked for it. `/sleep` answers as soon as the run has a Session, so a reflection of several minutes does not hold the composer. `/sleep status` reports how that run ended.

<a id="where-the-notes-live"></a>
## Where the notes live

The `dir` field names the notes directory. The shipped patch sets it to `dshHomePath('sleep')`, which is `$DSH_HOME/sleep`, or `~/.dsh/sleep` when `DSH_HOME` is unset. The runtime creates the directory with user-only permissions (`0700`) when it activates, and every subdirectory it creates uses the same mode.

The notes are plain text files below that directory. The sleep Session writes them through seven tools: `sleep_list_sessions`, `sleep_read_session`, `sleep_notes_list`, `sleep_notes_read`, `sleep_notes_write`, `sleep_notes_move`, and `sleep_notes_delete`. A working Session reads the same files with its own `read` tool, because the reminder block lists each note that did not fit the inline budget by absolute path.

The notes belong to the DSH home, not to a workspace. Every workspace reads the same notes.

<a id="known-limitations"></a>
## Known Limitations

- **Not shipped with DSH** — the bundle is not in `OPTIONAL_BUNDLES` and not in the plugin manager's Official group, and it declares no official icon. Install it from this repository, as described above.
- **One run at a time per Host** — a scheduled slot that fires while another run holds the slot is refused, and the local date counts as decided until the Host restarts. Two Hosts that share one `DSH_HOME` each own a slot, a timer, and a decision date while they share the notes directory: they can both start a run for the same day, overwrite each other's notes, and save conflicting outcomes. Coordinating them needs a cross-process lock this package does not own.
- **Global agent instructions in a base-derived profile** — an instruction loader mounted as a Host row applies to every Agent, so the preset alone cannot keep `AGENTS.md` out of a sleep Session. The runtime's instruction guard removes every message that loader would contribute, whatever composed it, and it reads the preset the Agent composed, so a Session started from the picker is covered too. A Session's notes block is unaffected: the guard drops only messages the instruction loader produced.
- **A note path can still lose a swap race** — the canonical path is checked again immediately before each filesystem call. Node exposes no descriptor-relative operation, so an ancestor directory swapped for a symbolic link inside the last gap between that check and the call can still redirect the call. A platform or filesystem that reports no file identity cannot detect that redirect at all. The notes directory is created with user-only permissions (`0700`), which limits who can perform the swap.
- **Global notes only** — the notes directory belongs to the DSH home, not to a workspace. A project-level layer is not implemented.
- **No settings page** — the schedule, the zone, and the byte limits are profile configuration. `/sleep status` reports the current values; changing them needs an edit to `cordis.patch.yml`.
- **The sleep Session cannot read project files** — the preset mounts no filesystem or shell tool, and its isolation row masks the global ones. The runtime's seven tools read Session transcripts and the notes directory alone.
- **The sleep preset is selectable** — every registered preset appears in the Agent-preset picker. A Session started as `Sleep` deliberately gets the reflective persona, the isolation, and nothing else: no project tools, no sleep tools, no instructions, and no notes block. The runtime registers the seven tools in the Session it creates itself.
- **`lastSleepAt` needs a completed, uncancelled turn** — an aborted, failed, output-capped, or cancelled sleep leaves the boundary where it was, so the next attempt re-reads the same working Sessions.

<a id="links"></a>
## Links

- Upstream project: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- DSH documentation: [docs](https://github.com/deepseek-ai/deepseek-harness/tree/main/docs)
- Issues for this plugin: [AngryRaccoon77/dsh-electric-sheep/issues](https://github.com/AngryRaccoon77/dsh-electric-sheep/issues)
- License: [MIT](LICENSE)
