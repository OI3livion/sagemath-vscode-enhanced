# Change Log

All notable changes to the "SageMath Enhanced" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added - Live SageMath documentation & signature help

- **Live documentation from the SageMath runtime**: hover and completion now
  show real docstrings and signatures pulled from the user's installed SageMath
  via `sage.misc.sageinspect` (a background `sage` process, started lazily and
  cached). Documentation is therefore always correct for the installed Sage
  version, including user-installed packages.
- **Signature help (parameter hints)**: typing inside a call (e.g.
  `PolynomialRing(`) now shows a parameter popup with the active parameter
  highlighted as you type commas.
- **Richer hover cards**: hover now renders the full signature, a parameter
  table, and code examples (converted from reST to Markdown).
- **Signatures in the completion list**: the `detail` column shows each
  function's argument list.
- **Graceful fallback**: when SageMath is not installed or unavailable, the
  extension falls back to the bundled one-line documentation, so hover and
  completion keep working.
- **New settings**: `sagemathEnhanced.enableSageDocs`,
  `sagemathEnhanced.hoverVerbosity` (`short` | `full`),
  `sagemathEnhanced.hoverShowExamples`.
- **Bugfix**: aligned the language server's interpreter setting with the
  client's `sagemathEnhanced.interpreterPath` (previously the server read a
  non-existent `sagePath` key and only worked by accident).
- **Robust daemon launch**: the documentation daemon is now launched via
  multiple methods tried in order (`sage -python`, `sage --python`, the
  configured `sagePythonPath`, `python`, `python3`), auto-detecting whichever
  reports a successful sage import and remembering it. This fixes environments
  where `sage -python` is unavailable (e.g. conda/micromamba installs), which
  previously caused hover/completion to silently fall back to the bundled docs
  after a "Loading..." delay.
- **Snappier completion**: completion item resolution no longer blocks on sage
  startup (it renders from cache/bundled instantly and warms the cache in the
  background once sage is ready). The daemon is also pre-warmed on the first
  document activity so the first hover isn't slow.
- **New settings**: `sagemathEnhanced.sagePythonPath`,
  `sagemathEnhanced.sageDocLaunchMethod`.

### Changed

- Extracted documentation content and rendering out of `server.ts` into
  dedicated modules (`symbolDocs.ts`, `rstToMarkdown.ts`, `sageBackend.ts`,
  `signatureHelp.ts`).
- Fixed the `vscode-test` glob in `.vscode-test.mjs` so `npm test` actually
  discovers the compiled tests.

## [2.0.0] - 2024-01-XX

### Added - Major Rewrite with LSP Implementation

- **Language Server Protocol (LSP) Support**: Complete rewrite with full LSP implementation
- **Intelligent Code Completion**: Context-aware autocompletion for SageMath functions, classes, and methods
- **Hover Documentation**: Instant documentation and type information on hover
- **Enhanced Syntax Highlighting**: Comprehensive syntax highlighting for SageMath-specific constructs:
  - Ring and field declarations (ZZ, QQ, RR, CC, GF, etc.)
  - Polynomial rings and generators
  - Mathematical functions and operators
  - Linear algebra operations
  - Plotting and visualization functions
  - Number theory and combinatorics functions
  - Cryptographic functions
  - Graph theory constructs
- **Code Snippets**: 30+ pre-built code snippets for common SageMath patterns
- **Enhanced Language Configuration**: Improved indentation, bracket matching, and auto-closing pairs
- **Real-time Diagnostics**: Syntax validation and error detection
- **Server Management**: Restart language server command for troubleshooting
- **Extended Configuration**: New settings for controlling LSP features

### Changed

- Completely rewritten extension architecture with proper LSP client-server design
- Enhanced TextMate grammar with comprehensive SageMath pattern recognition
- Improved language configuration with better editor experience
- Updated package.json with new commands and configuration options

### Technical Improvements

- Migrated from simple command-based extension to full LSP implementation
- Added TypeScript language server with SageMath-specific capabilities
- Implemented proper client-server communication via JSON-RPC
- Enhanced build system to support both client and server compilation
- Added comprehensive code snippets for better developer experience

## [1.3.3] - Previous Version

- Basic script execution functionality
- Simple TextMate grammar inheriting from Python
- Windows WSL support (partial)
- Automatic .sage.py file cleanup

## [1.0.0] - Initial Release

- Basic SageMath file execution
- Simple syntax highlighting