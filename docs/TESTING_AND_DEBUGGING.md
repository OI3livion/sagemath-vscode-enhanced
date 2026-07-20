# Testing & Debugging the Extension

This guide explains how to **build**, **test**, and **debug** the *SageMath Enhanced*
VS Code extension from inside VS Code (and from the command line).

It assumes you have already cloned the repository and have
[Node.js](https://nodejs.org/) >= 18 and `npm` installed.

---

## 1. Project layout (so you know what you are debugging)

| Path | What it is |
|------|------------|
| `src/extension.ts` | The **extension client** (entry point). Registers commands and starts the language server. Compiles to `out/src/extension.js`. |
| `server/src/server.ts` | The **language server** (LSP). Provides completion, hover, diagnostics, definition, references, document symbols. Compiles to `out/server/src/server.js`. |
| `out/` | Compiled JavaScript (git-ignored). The VSIX ships only this folder. |
| `syntaxes/sage.tmLanguage.json`, `language-configuration.json`, `snippets/sage.json` | Grammar, language config, snippets (shipped as-is). |
| `tests/` | LSP harness scripts and `.sage` files for manual testing. |
| `src/test/extension.test.ts` | Unit tests run by `vscode-test`. Compiles to `out/src/test/extension.test.js`. |
| `.vscode/launch.json`, `.vscode/tasks.json` | Shared debug/build configs (see below). |

The TypeScript config (`tsconfig.json`) uses `rootDir: "."`, so sources compile
to mirrored paths under `out/` (e.g. `src/extension.ts` → `out/src/extension.js`,
`server/src/server.ts` → `out/server/src/server.js`).

---

## 2. First-time setup

```bash
npm install      # install dependencies
```

This creates `node_modules/`. You only need to repeat it when `package.json`
or `package-lock.json` change.

---

## 3. Building & packaging

### Option A — One command (recommended)

```bash
./build.sh
```

`build.sh` reproduces exactly what CI does: install deps (if missing) →
compile (`tsc`) → lint (`eslint`) → package (`vsce package`). It prints the path
to the resulting `.vsix`, its size and sha256, and the `code --install-extension`
command to install it.

Useful flags:

```bash
./build.sh --clean        # remove out/ and old *.vsix first
./build.sh --no-install   # skip npm install (node_modules must already exist)
./build.sh --no-lint      # skip ESLint
./build.sh --help
```

> **Tip:** A dirty git working tree can make `vsce` refuse to package
> (`ERROR  Git working directory not clean`). Commit or stash your changes,
> or build from a clean checkout.

### Option B — Manual steps

```bash
npm run compile     # tsc -p .
npm run lint        # eslint src --ext ts
npx @vscode/vsce package    # produces sagemath-enhanced-<version>.vsix
```

### Installing the built VSIX for manual QA

```bash
code --install-extension ./sagemath-enhanced-2.0.8.vsix
# or, inside VS Code: Extensions view  ⋯  ▸  "Install from VSIX..."
```

To reinstall after a rebuild, add `--force`.

## 4. Running the tests

There are three layers of tests.

### 4.1 Unit tests (`vscode-test`)

```bash
npm test
```

This launches a headless VS Code instance and runs
`src/test/extension.test.ts` (compiled to `out/src/test/extension.test.js`).
The glob is configured in `.vscode-test.mjs`.

> ⚠️ **Headless / CI note:** `vscode-test` downloads a VS Code build and needs a
> display. On Linux without X, export `xvfb` or run inside CI (see
> `.github/workflows/ci.yml`, which currently runs compile + lint + a VSIX
> packaging check because the integration tests need a display).

### 4.2 LSP completion harness (no display needed)

`tests/test_lsp_completion.js` spins up the compiled server
(`out/server/src/server.js`) over stdio, speaks LSP, and asserts that inputs
like `Poly`, `PolRin`, `polR` return `PolynomialRing` near the top of the list.

```bash
npm run compile            # the harness runs the compiled server
node tests/test_lsp_completion.js
```

This is the fastest way to validate language-server behavior from the terminal.

### 4.3 Interactive / manual testing

```bash
./tests/test_completion.sh      # menu-driven: automated + open a .sage in VS Code
```

Or open any of the `.sage` files under `tests/` in a Development Host (below)
and try completion/hover with `Ctrl+Space` and mouse hover.

---

## 5. Debugging inside VS Code

### 5.1 The Extension Development Host (debug the client)

The shared `.vscode/launch.json` provides a **Run Extension (Development Host)**
configuration.

1. Open the project folder in VS Code.
2. Press **F5** (or Run & Debug ▸ *Run Extension (Development Host)*).
3. A **second VS Code window** opens with the extension loaded from `out/`.
4. Open a `.sage` file there and exercise it.
5. Set breakpoints in `src/extension.ts` — they will be hit.

`preLaunchTask: "npm: compile"` rebuilds before each launch so you always debug
fresh code. For live editing, run the **npm: watch** task in the background
(`Terminal ▸ Run Task ▸ npm: watch`) so `tsc` recompiles on every save; then F5.

### 5.2 Debugging the language server (`server/src/server.ts`)

The server runs in a child Node process spawned by the client. To breakpoint it:

**Method 1 — Auto Attach (zero-config, recommended):**

1. Run VS Code command **"Debug: Toggle Auto Attach"** ▸ choose **"Smart"** (or
   "On"). You may need to restart the terminal/window once.
2. F5 to launch the Development Host.
3. The server child process is automatically attached; breakpoints in
   `server/src/server.ts` are hit.

**Method 2 — Attach explicitly (port 6009):**

The `.vscode/launch.json` has an **Attach to Language Server** config that
attaches on port 6009. For it to connect, the server must be started with an
inspect port. Add the `options.execArgv` to the *debug* server options in
`src/extension.ts` (it only affects debug launches and does **not** change the
packaged extension's behavior):

```ts
const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
        module: serverModule,
        transport: TransportKind.ipc,
        options: { execArgv: ['--nolazy', '--inspect=6009'] } // <-- add this
    }
};
```

Then: F5 the Development Host → run the **Attach to Language Server** config in
the *original* window → breakpoints in `server.ts` are hit. `restart: true`
(it's already set) makes it reattach when the server restarts.

### 5.3 Where to read logs

- **Extension Output channel:** In the Development Host, `View ▸ Output` ▸ select
  **"SageMath Enhanced"** in the dropdown. Client-side logs go here.
- **Server logs:** `server.ts` uses `connection.console.log(...)`. These appear
  in the same Output channel and/or in the **"Log (Extension Host)"** output.
- **Developer Tools:** `Help ▸ Toggle Developer Tools` shows console output from
  the extension host and any uncaught errors.
- **Server process logs:** When using Auto Attach / inspect, the Node inspector
  and `console.*` output appear in the parent Extension Host's debug console.

### 5.4 Handy commands while debugging

| Command | Purpose |
|--------|---------|
| `Developer: Reload Window` | Reload the Development Host after a code change (or just close & F5 again). |
| `SageMath: Restart Language Server` (`sagemathEnhanced.restartServer`) | Restart the language server without reloading the window. |
| `Debug: Toggle Auto Attach` | Enable automatic attachment to spawned Node processes (for the server). |

---

## 6. Continuous Integration

`.github/workflows/ci.yml` runs on pushes/PRs to `main` and performs compile,
lint, and a VSIX packaging check. `.github/workflows/publish.yml` builds and
publishes a release on pushes to `main` (see `docs/RELEASE_PROCESS.md`).

`build.sh` is the local equivalent of the CI packaging steps.

---

## 7. Troubleshooting

- **`npm test` reports 0 tests / "no tests found":** Ensure you compiled
  (`npm run compile`) and that `.vscode-test.mjs` globs `out/src/test/**/*.test.js`
  (matching the `rootDir: "."` output layout).
- **Completion/hover not appearing in the Development Host:** Make sure the file
  has a `.sage` extension and language mode *SageMath*; run
  `SageMath: Restart Language Server`; check the **SageMath Enhanced** output
  channel for server errors; confirm `out/server/src/server.js` exists.
- **Breakpoints in `server.ts` not binding:** You are not attached to the server
  process — use Auto Attach (Section 5.2, Method 1) or add the `--inspect=6009`
  execArgv (Method 2).
- **`vsce package` fails with "Git working directory not clean":** Commit/stash
  changes, or build from a clean checkout.
- **Changes not picked up after editing:** You forgot to recompile. Either run
  `npm: watch` or relaunch F5 (the `preLaunchTask` recompiles).
- **Hover/completion shows only short bundled docs (no live signatures):** the
  live-docs daemon could not start SageMath. The language server logs which
  launch method it tried in the **SageMath Enhanced** output channel (lines like
  `[sage-docs] trying launch method: …` / `sage backend ready via "…"` /
  `all launch methods failed: …`). Common fixes:
  - Activate the SageMath environment *before* launching VS Code
    (e.g. `micromamba activate sage && code .`) so `sage`/`python` with sage is
    on `PATH`.
  - `sage -python` is not available in some packagings; the server falls back to
    `python`/`python3` automatically. If auto-detection fails, set
    **`sagemathEnhanced.sagePythonPath`** to the exact Python that has SageMath
    importable (e.g. `/opt/sage/local/bin/python3`), or pin
    **`sagemathEnhanced.sageDocLaunchMethod`** to e.g. `"python"`.
  - Set **`sagemathEnhanced.logLevel`** to `debug` for more detail.
  - You can always disable the runtime integration with
    **`sagemathEnhanced.enableSageDocs: false`** to use only the bundled docs.

