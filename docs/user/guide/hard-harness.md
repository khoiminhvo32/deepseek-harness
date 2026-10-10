# Run a Meebard Harness security audit

English | [中文](hard-harness.zh.md)

## Summary

Meebard Harness, the hard harness, turns a Web UI session into a long-running security audit of one target: a git repository, a plain directory, or a single file. The agent sweeps every module for a fixed list of bug classes, reads modules deeply, records every weakness it finds, chains weaknesses toward higher impact, and proves each finding with a proof of concept (PoC) that the harness runs itself. The session keeps working across turns, provider quota stops, and connection failures until the harness certifies the audit complete. Expect a long run: a mid-size target takes many hours and many model requests.

## Table of Contents

- [Before you start](#before-you-start)
- [Create the hard-web profile](#create-profile)
- [Start an audit](#start-an-audit)
- [Follow the audit](#follow-the-audit)
- [Keep the audit running](#keep-running)
- [Add blind audits](#blind-audits)
- [Troubleshooting](#troubleshooting)
- [Further Exploration](#further-exploration)

<a id="before-you-start"></a>
## Before you start

You need a working `dsh` command: an installed `dsh`, or a repository checkout where you run `pnpm dsh` from the checkout root. You also need a model key from a provider whose terms allow use in this application; [Configure models](./providers.md) explains how to add one. The commands below use `$DSH_HOME`, which defaults to `~/.dsh`.

Choose the target first. The harness captures the target into its own git snapshot when the profile loads, so later edits in the target directory never change what the audit reads or cites.

<a id="create-profile"></a>
## Create the hard-web profile

A profile is a directory under `$DSH_HOME/profiles/`. Create `$DSH_HOME/profiles/hard-web/package.json` with the Web bundles and the hard bundle:

```json
{
  "name": "dsh-profile-hard-web",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-experimental-hard-bundle"] } }
}
```

Then create `$DSH_HOME/profiles/hard-web/cordis.patch.yml` with the objective and the absolute target path:

```yaml
- id: hard-mission
  config:
    objective: 'Find and prove exploitable vulnerabilities in the target'
    target:
      repoPath: '/absolute/path/to/target'
```

The objective is the durable goal the agent keeps working toward, so state what you want found and proven. The [hard-mission reference](../../../packages/experimental/hard-mission/README.md) lists the other fields, such as `bugClasses` and `target.moduleDepth`.

<a id="start-an-audit"></a>
## Start an audit

Start the Web UI with the profile:

```sh
pnpm dsh --profile hard-web
```

An installed command is `dsh --profile hard-web`. Add `--port <n>` to choose the port and `--no-open` to skip opening a browser; the command prints the URL with its access token.

In the Web UI, configure a model under **Settings → Models**, add the target directory as the workspace, and start a session. Each new session in this profile is a separate audit of the configured target. Send a short instruction such as “Start the audit.” The agent then works in rounds without further prompts.

Open the **Meebard coverage matrix** tab in the right sidebar to see the module × bug-class grid, the coverage ratio, the pinned commit, and what still blocks completion.

<a id="follow-the-audit"></a>
## Follow the audit

The agent works in three kinds of rounds. Systematic rounds sweep modules for each bug class and record a verdict per cell. Deep-reading rounds model dataflow, trust boundaries, and state machines, and open hypotheses. Chaining rounds run every few rounds once two or more weaknesses or confirmed findings exist, and combine what one weakness grants with what another requires.

The harness checks the agent's work instead of trusting it:

- A cleared cell must cite the code it inspected. The harness resolves every citation at the pinned commit and refuses a clear that cites code which is not there.
- The harness re-greps a sample of cleared cells and reopens a cell when it finds sink sites the agent did not declare.
- A finding counts only when the harness runs its PoC: the exploit run must succeed and the same PoC must fail with a harmless payload.
- The agent cannot finish early. A completion attempt is refused with the exact remaining work.

Ask the agent at any time, for example: “List the confirmed findings, the recorded weaknesses, and the open hypotheses.” Confirmed findings are the reportable results; weaknesses and hypotheses are material for further work.

<a id="keep-running"></a>
## Keep the audit running

When the provider reports an exhausted quota, the harness waits until the reset time and resumes the audit. When a turn ends on a rate limit, a server error, a timeout, or a connection failure, it waits a few minutes and resumes. The [hard-standby reference](../../../packages/experimental/hard-standby/README.md) lists the exact failures and waits.

A server restart stops the audit's automatic continuation. After the restart, open the session and choose **Resume goal** in the goal area of the session. A plain message runs one turn, but the audit does not continue on its own after that turn.

Restart the server only while no delegated agent is running. A restart stops delegated agents, and their unsent work is lost.

<a id="blind-audits"></a>
## Add blind audits

You can let a second model re-read a sample of the agent's cleared cells without seeing the agent's reasoning. Each re-read costs extra model requests. Add this entry to `cordis.patch.yml`:

```yaml
- id: hard-audit
  config:
    enabled: true
```

The [hard-audit reference](../../../packages/experimental/hard-audit/README.md) explains sampling, the per-mission budget, and how to route the reader to a different model.

<a id="troubleshooting"></a>
## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Startup prints `hard-mission … $.target missing required value` and the coverage tab stays empty. | `cordis.patch.yml` has no `target.repoPath`. Add the absolute target path and restart. |
| The session stopped and no new round starts. | The goal is not active in this server process, for example after a restart. Choose **Resume goal**. |
| The agent reports a citation refused because a file “has N lines”. | The agent cited a line past the end of the file. The agent corrects the citation; no action is needed. |
| Model requests fail with a quota error. | The harness waits for the reset and resumes on its own. Check your provider account when the error says the balance is exhausted. |

<a id="further-exploration"></a>
## Further Exploration

- [Hard harness subsystem](../../subsystems/hard-harness.md): how the ledger, verifier, and gate work together.
- [Hard tools reference](../../../packages/experimental/hard-tools/README.md): the tools the agent uses to record its work.
- [Configure models](./providers.md)
