# Change Log

All notable changes to the "SageMath Enhanced" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added - Live SageMath documentation & signature help

- **Live documentation from the SageMath runtime**: hover and completion now
  show real docstrings and signatures from the user's installed SageMath. The
  daemon now uses **Jedi (static analysis) as the primary engine**, with a safe
  `getattr`-on-`sage.all` fallback for Cython symbols Jedi cannot read (e.g.
  `ZZ`, `QQ`, `matrix`). **No `eval`, no allowlist** — editor text is parsed,
  never executed.
- **Signature help (parameter hints)**: typing inside a call (e.g.
  `PolynomialRing(`) shows a parameter popup via Jedi's `get_signatures`, with
  the active parameter highlighted.
- **Completion no longer competes inside calls**: when the cursor is inside `()`
  on a line, the general SageMath function list is withheld and the callee's
  **keyword arguments** are offered instead (e.g. `plot(` → `funcs`, `xrange`,
  `parametric`, `polar`, …), with already-used kwargs deduplicated.
- **Dotted completion**: typing `obj.` now offers the object's real attributes
  and methods via Jedi (e.g. `MS.` on a `MatrixSpace` returns `base_ring`,
  `nrows`, `characteristic`, …). Falls back to the static common-method list
  when Jedi cannot infer the receiver type (Cython singletons/constructors).
- **Broader general completion**: the general list now merges Jedi results with
  the prioritized static list, so names not in the hardcoded list (e.g.
  `MatrixSpace`) now appear while `PolynomialRing` stays #1 for `Poly`.
- **Richer hover cards**: full signature, parameter table, and code examples
  (reST converted to Markdown).
- **Graceful fallback**: when SageMath/Jedi is unavailable, hover/completion
  fall back to the bundled one-line documentation.
- **Robust daemon launch**: tries `sage -python`, `sage --python`, the
  configured `sagePythonPath`, `python`, `python3` in order, remembering the one
  that works (fixes conda/micromamba installs where `sage -python` is absent).
- **New settings**: `sagemathEnhanced.enableSageDocs`,
  `sagemathEnhanced.hoverVerbosity`, `sagemathEnhanced.hoverShowExamples`,
  `sagemathEnhanced.sagePythonPath`, `sagemathEnhanced.sageDocLaunchMethod`.

### Changed

- `server/sage_doc_daemon.py` rewritten from an `eval`+allowlist design to a
  Jedi + safe-getattr design (no arbitrary code execution from editor content).
- Extracted documentation rendering into `symbolDocs.ts`, `rstToMarkdown.ts`,
  `sageBackend.ts`, `signatureHelp.ts`.
- Fixed the `vscode-test` glob in `.vscode-test.mjs` so `npm test` discovers
  the compiled tests.

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