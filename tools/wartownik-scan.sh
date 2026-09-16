#!/bin/sh
# wartownik-scan.sh - mechaniczna brama pre-push/pre-commit/CI (Wartownik N-04).
# Skanuje DELTE (dodane linie) na SEKRETY i HELD-OUT. Fail-closed: match => exit 1 (REJECT).
# Nie zalezy od obecnosci security-agenta - "scan przed push" jako KOD, nie ceremonia.
#
# Uzycie:
#   sh wartownik-scan.sh <repo_dir> <base_ref> <head_ref> [exclude_pathspec]
#   np. sh wartownik-scan.sh . github/main feat/token-checkpoint-lm
# 4. arg (opcjonalny): git pathspecy do wykluczenia (domyslnie wlasne zrodlo + workflows,
#   bo skrypt zawiera wzorce-literaly i self-matchowalby wlasny commit - blocker#1 Montera).
set -u
REPO="${1:?repo_dir}"; BASE="${2:?base_ref}"; HEAD="${3:?head_ref}"
EXCL="${4:-:(exclude,glob)**/wartownik-scan.sh :(exclude,glob).github/workflows/**}"
set -f  # noglob: pathspec-y (* w :(exclude)) nie moga byc rozwiniete przez shell
DIFF="$(git -C "$REPO" diff "$BASE".."$HEAD" -- . $EXCL 2>/dev/null | grep '^+' | grep -v '^+++')"
set +f

# --- SEKRETY: klucze/tokeny/PEM. Filtr false-positive slowa "token" (subword-token). ---
SEC="$(printf '%s\n' "$DIFF" | grep -iE '(api[_-]?key|secret|passwd|password|BEGIN [A-Z ]*PRIVATE KEY|-----BEGIN|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{34}|xox[baprs]-|Bearer [A-Za-z0-9._-]{8})' \
  | grep -ivE 'TRACK_RUNNER_TOKEN|token_model|TokenCheck|TokenGPT|subword|tokeniz|token-level|token protocol|api_url|next-token')"

# --- HELD-OUT: hard-blocklist SHA (canary/heldout) + wzorce content/sciezki. ---
HELD="$(printf '%s\n' "$DIFF" | grep -iE 'c5357ff0|c4b4990fef|bdc2f2bb|"text"[[:space:]]*:|heldout|held-out|eval[_-]?set|canary|_autobench_candidate')"

RC=0
if [ -n "$SEC" ];  then echo "REJECT: potencjalny SEKRET w delcie:";   printf '%s\n' "$SEC"  | head -20; RC=1; fi
if [ -n "$HELD" ]; then echo "REJECT: potencjalny HELD-OUT/canary w delcie:"; printf '%s\n' "$HELD" | head -20; RC=1; fi
[ "$RC" -eq 0 ] && echo "PASS: delta czysta (zero sekretow, zero held-out)."
exit "$RC"
