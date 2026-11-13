#!/usr/bin/env bash
# Print the semver bump for the commits since BASE that touch the current
# directory, from their Conventional Commit messages:
#
#   major  a "type!:" subject or a "BREAKING CHANGE:" footer
#   minor  a feat commit
#   patch  a fix or perf commit
#   none   anything else (docs, chore, test, ci, refactor, ...)
#
# usage: release-level.sh BASE
set -euo pipefail

base="${1:?usage: release-level.sh BASE}"
range="${base}..HEAD"

subjects="$(git log --format=%s "$range" -- .)"
bodies="$(git log --format=%b "$range" -- .)"

if grep -qE '^[a-z]+(\([^)]*\))?!:' <<<"$subjects" || grep -qE '^BREAKING[ -]CHANGE:' <<<"$bodies"; then
  echo major
elif grep -qE '^feat(\([^)]*\))?:' <<<"$subjects"; then
  echo minor
elif grep -qE '^(fix|perf)(\([^)]*\))?:' <<<"$subjects"; then
  echo patch
else
  echo none
fi
