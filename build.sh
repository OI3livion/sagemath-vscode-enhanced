#!/usr/bin/env bash
#
# build.sh - Build and package the "SageMath Enhanced" VS Code extension (.vsix)
#
# This script reproduces the same steps the CI uses (install -> compile -> lint ->
# package) so you can produce a release-quality .vsix from your machine.
#
# Usage:
#   ./build.sh                Full build: install deps (if missing), compile, lint, package
#   ./build.sh --no-install   Skip installing dependencies (node_modules must already exist)
#   ./build.sh --no-lint      Skip ESLint
#   ./build.sh --clean        Remove out/ and any existing *.vsix first
#   ./build.sh --help         Show this help
#
set -euo pipefail

# Pretty output (disabled when stdout is not a TTY or NO_COLOR is set)
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
	C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
	C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
	C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi

log()  { printf '%s\u25b6%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '%s\u2713%s %s\n'  "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n'       "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s\u2717%s %s\n'  "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# Always operate from the repository root (the directory containing this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Argument parsing
DO_INSTALL=1
DO_LINT=1
DO_CLEAN=0
for arg in "$@"; do
	case "$arg" in
		--no-install) DO_INSTALL=0 ;;
		--no-lint)    DO_LINT=0 ;;
		--clean)      DO_CLEAN=1 ;;
		-h|--help)    sed -n '3,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) die "Unknown argument: $arg (try --help)" ;;
	esac
done

# Prerequisites
command -v node >/dev/null 2>&1 || die "node was not found in PATH. Install Node.js >= 18."
command -v npm  >/dev/null 2>&1 || die "npm was not found in PATH."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
	warn "Node $(node -v) detected; Node >= 18 is recommended (CI uses 20)."
fi

VERSION="$(node -p "require('./package.json').version")"
VSIX="sagemath-enhanced-${VERSION}.vsix"

echo
log "Building ${C_BOLD}SageMath Enhanced v${VERSION}${C_RESET} in:"
echo "    ${SCRIPT_DIR}"
echo

# Optional clean
if (( DO_CLEAN )); then
	log "Cleaning previous build artifacts (out/, *.vsix)"
	rm -rf out
	rm -f ./*.vsix
fi
# Dependencies
if (( DO_INSTALL )); then
	if [[ ! -d node_modules ]]; then
		if [[ -f package-lock.json ]]; then
			log "Installing dependencies via 'npm ci'"
			npm ci
		else
			log "Installing dependencies via 'npm install'"
			npm install
		fi
		ok "Dependencies installed"
	else
		ok "node_modules already present (skipping install)"
	fi
else
	[[ -d node_modules ]] || die "node_modules is missing and --no-install was given. Run ./build.sh once without --no-install."
fi

# Compile (tsc -p .)
log "Compiling TypeScript (npm run compile)"
npm run compile
ok "Compilation finished"

# Sanity-check the compiled entry points the extension actually loads.
[[ -f out/src/extension.js ]]     || die "Expected output not found: out/src/extension.js"
[[ -f out/server/src/server.js ]] || die "Expected output not found: out/server/src/server.js"

# Lint
if (( DO_LINT )); then
	log "Running ESLint (npm run lint)"
	if npm run lint; then
		ok "Lint passed"
	else
		die "Lint failed. Fix the issues above, or rerun with --no-lint."
	fi
fi

# Package the .vsix with @vscode/vsce
# Prefer a globally/locally installed vsce; otherwise fetch it on the fly.
if command -v vsce >/dev/null 2>&1; then
	VSCE_CMD=(vsce)
elif [[ -x node_modules/.bin/vsce ]]; then
	VSCE_CMD=(node_modules/.bin/vsce)
else
	log "Fetching @vscode/vsce via npx (this may take a moment on first run)"
	VSCE_CMD=(npx --yes @vscode/vsce@latest)
fi

log "Packaging VSIX ($VSIX)"
# Remove a stale VSIX for this version so a packaging failure is detectable.
rm -f "$VSIX"

# A dirty git working tree can make vsce refuse to package. If that happens,
# commit/stash your changes (or build from a clean checkout) and re-run.
"${VSCE_CMD[@]}" package

[[ -f "$VSIX" ]] || die "vsce did not produce $VSIX"

# Summary
SIZE="$(du -h "$VSIX" | cut -f1)"
if command -v sha256sum >/dev/null 2>&1; then
	SHA="$(sha256sum "$VSIX" | cut -d' ' -f1)"
else
	SHA="$(shasum -a 256 "$VSIX" | cut -d' ' -f1)"
fi

echo
ok "${C_BOLD}Build successful${C_RESET}"
printf '  %sVersion%s : %s\n'   "$C_BOLD" "$C_RESET" "$VERSION"
printf '  %sVSIX%s    : %s%s/%s%s\n' "$C_BOLD" "$C_RESET" "$C_GREEN" "$SCRIPT_DIR" "$VSIX" "$C_RESET"
printf '  %sSize%s    : %s\n'   "$C_BOLD" "$C_RESET" "$SIZE"
printf '  %ssha256%s  : %s\n'   "$C_BOLD" "$C_RESET" "$SHA"
echo
printf '%sInstall in VS Code:%s\n' "$C_BOLD" "$C_RESET"
printf '    code --install-extension "%s/%s"\n' "$SCRIPT_DIR" "$VSIX"
printf '    # or: Extensions view \u22b8 \u2026 \u22b8 "Install from VSIX..."\n'
echo
