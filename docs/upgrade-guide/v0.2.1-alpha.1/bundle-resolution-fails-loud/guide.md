---
kind: upgrade-guide
description: "A profile bundle that resolves from neither the dsh installation nor the profile directory fails the load instead of booting without the bundle."
---

# Unresolvable profile bundles fail the load

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.1, profile loading resolves every `dsh.profile.bundles` entry from the dsh installation first and the profile directory second (`loadProfileDirectory` in `packages/boot/app-boot`). When neither anchor resolved a bundle, the loader recorded the failure in `skippedBundles`, printed `dsh: skipping profile bundle "<name>": …` once per start, and booted anyway.

The next release fails the load instead: the resolution error propagates and `dsh` exits nonzero with `cannot resolve profile bundle "<name>" from the dsh installation or <profileDir>`. Anyone whose profile names a bundle missing from both anchors is affected — the boot previously degraded silently into a session without that bundle's plugins.

Failures of bundle *content* keep the old behavior: an unreadable manifest, a missing or broken patch, and unexempted peer incompatibilities still skip and appear in `skippedBundles`. Only the missing referent fails loud.

## Migration

1. If the bundle should be present, install it into the profile: run `dsh plugin --profile <name> install`, or declare the bundle in the `dependencies` of `$DSH_HOME/profiles/<name>/package.json` and install.
2. If the bundle is no longer needed, delete its name from `dsh.profile.bundles` in `$DSH_HOME/profiles/<name>/package.json`.
3. When developing from a workspace checkout with an unpublished bundle — the experimental hard bundles are not `apps/cli` dependencies — symlink the package into the profile: `ln -sfn <repo>/packages/<group>/<pkg> "$DSH_HOME/profiles/<name>/node_modules/@deepseek-ai/<pkg>"`.
4. Confirm: `dsh --profile <name>` starts with no `cannot resolve profile bundle` line and no `did not activate` warning.
