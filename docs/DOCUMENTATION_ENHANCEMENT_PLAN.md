# Plan: Richer Documentation & Function Argument Display

> ## ✅ Implementation status (branch `feature/sage-runtime-docs`)
>
> Phase 0 **and** Phase 1 are implemented, but with a better architecture than
> the hand-authored corpus described in §3 below: documentation and signatures
> are now pulled **live from the user's installed SageMath** via
> `sage.misc.sageinspect`, with the curated one-line strings kept only as a
> fallback. This makes the docs version-accurate by construction and removes the
> need to author hundreds of entries.
>
> **What shipped:**
> - `server/sage_doc_daemon.py` — persistent sage subprocess (allowlist-guarded,
>   method resolution via host objects, JSON-over-stdio). Verified to run and to
>   degrade gracefully when sage is absent.
> - `server/src/sageBackend.ts` — lazy, supervised, cached bridge to the daemon
>   (request/response correlation, restart-on-crash, graceful fallback).
> - `server/src/rstToMarkdown.ts` — dependency-free reST→Markdown normalizer
>   (EXAMPLES::, INPUT/OUTPUT, `:func:`/`:trac:` roles, admonitions).
> - `server/src/symbolDocs.ts` — `SymbolDoc` model, `docFromSage()` converter
>   (extracts signature, params, summary, description, EXAMPLES→`example`),
>   hover/completion renderers, and the bundled fallback corpus.
> - `server/src/signatureHelp.ts` — `getCallContextFromText()` (string/comment
>   aware call parser for signature help).
> - `server/src/server.ts` — wired hover, completion, completion-resolve and a
>   new `textDocument/signatureHelp` provider; fixed the `sagePath`→
>   `interpreterPath` setting mismatch; added `enableSageDocs`, `hoverVerbosity`,
>   `hoverShowExamples` settings.
> - Unit tests for the pure modules (`src/test/*.test.ts`) — all passing.
>
> Sections §3–§10 below remain valid as the original design rationale; where the
> implementation diverges (live sage instead of a static `BUILTIN_DOCS`
> corpus), the live approach supersedes it. Future work: Phase 2 (richer method
> coverage via more host objects) and Phase 3 (snippet insert texts).

**Status:** Phase 0 + Phase 1 implemented (see above); remainder is proposal.
**Scope:** `server/src/server.ts` (language server) + `package.json` settings + tests
**Goal:** (A) show **longer, richer documentation** on hover/completion, and
(B) display **function arguments** (signature help + signatures in the completion list).

---

## 1. Current state (what we have today)

Documentation today lives entirely in `server/src/server.ts` as two flat
single-line maps:

```ts
const SYMBOL_DOCUMENTATION: Record<string, string> = { ... };          // built-ins
const SYMBOL_METHOD_DOCUMENTATION: Record<string, string> = { ... };   // methods
```

Each value is **one line**, e.g.:
`'PolynomialRing': 'Creates a polynomial ring. Example: \`R = PolynomialRing(QQ, "x"); x = R.gen()\`.'`

These maps are consumed in three places:

| Handler | File / function | What it does today |
|---------|-----------------|--------------------|
| `connection.onCompletion` | `server.ts` ~L424 | Builds `CompletionItem` for each matching builtin/method. `detail` is a fixed string (`'SageMath built-in'` / `'SageMath method'`); `documentation` is a generic placeholder (`'SageMath built-in function or class: X'`). **No signature, no parameters.** |
| `connection.onCompletionResolve` | `server.ts` ~L504 | Replaces `documentation` with the one-line markdown from the maps (if present). |
| `connection.onHover` | `server.ts` ~L521 | Renders `**word** *(built-in)*` + the one-line doc. Also appends user-defined symbol info. |

There is **no signature help** (`textDocument/signatureHelp`), so typing
`PolynomialRing(` shows **no parameter hints**. There is also no `detail` carrying
the argument list in the completion list.

### Why this is limiting

- Documentation is capped at one sentence — no parameter list, no return value,
  no multi-line examples, no link to the upstream SageMath docs.
- Hover and the completion details show the same terse line.
- No in-call parameter guidance, which is the standard LSP way to "display
  arguments of functions."

---

## 2. Design goals (non-functional)

1. **No behavior change for the installed extension** beyond *more* information;
   existing hover/completion must keep working.
2. **Single source of truth** for docs, shared by hover, completion, and signature
   help (avoid the current drift risk between two maps).
3. **Progressive enhancement**: ship the new plumbing first, then author rich
   content for the most-used symbols, then fill in the rest.
4. **Configurable verbosity** so users on small screens can opt into shorter
   hover text.
5. **Keep `server.ts` readable**: move the (growing) documentation corpus into its
   own module.

## 3. Proposed data model

New file: **`server/src/symbolDocs.ts`** (picked up automatically by `tsconfig`
because `include` contains `server/src/**/*`; compiles to `out/server/src/symbolDocs.js`).

```ts
// server/src/symbolDocs.ts

export interface ParamDoc {
    name: string;            // e.g. "base_ring"
    type?: string;           // e.g. "Ring"            (optional, for display)
    description: string;     // e.g. "The coefficient ring of the polynomial ring."
    optional?: boolean;      // renders as [name] and drives snippet optionality
    default?: string;        // e.g. "None"            (rendered as name=default)
}

export interface SymbolDoc {
    signature: string;       // e.g. "PolynomialRing(base_ring, name=None, *, order='degrevlex')"
    summary: string;         // ONE line — the current hover headline text
    description?: string;    // multi-paragraph markdown (longer docs go here)
    params?: ParamDoc[];     // structured parameters
    returns?: string;        // what it returns
    raises?: string;         // notable exceptions (optional)
    example?: string;        // sage code shown in a ```sage block
    seeAlso?: string[];      // related symbols
    docUrl?: string;         // canonical SageMath doc URL (renders as a link)
    category?: string;       // e.g. "Rings", "Plotting" (future: filtering)
}

// The authoritative corpus. Keyed by symbol name.
export const BUILTIN_DOCS: Record<string, SymbolDoc> = {
    PolynomialRing: {
        signature: "PolynomialRing(base_ring, name=None, names=None, *, order='degrevlex')",
        summary: "Construct a (multivariate) polynomial ring over `base_ring`.",
        description:
            "Creates the ring of polynomials in one or more variables over the " +
            "given base ring. Pass either a single `name`/`names` string or a " +
            "list of variable names. The default term order is degree-reverse-" +
            "lexicographic.",
        params: [
            { name: "base_ring", type: "Ring", description: "Coefficient ring, e.g. `QQ`, `ZZ`, `GF(7)`." },
            { name: "name", type: "str", optional: true, description: "A single variable name, e.g. `'x'`." },
            { name: "names", type: "list[str] | str", optional: true, description: "Multiple variable names, e.g. `['x','y']` or `'x,y'`." },
            { name: "order", type: "str", optional: true, default: "'degrevlex'", description: "Term order: `'degrevlex'`, `'lex'`, `'invlex'`, etc." }
        ],
        returns: "A `PolynomialRing_dense`/`MPolynomialRing` object.",
        example:
            "R = PolynomialRing(QQ, 'x')\nx = R.gen()\nf = x^2 + 1\n"
            + "R2 = PolynomialRing(GF(7), ['x', 'y'])    # multivariate",
        seeAlso: ["LaurentPolynomialRing", "PowerSeriesRing", "FractionField"],
        docUrl: "https://doc.sagemath.org/html/en/reference/polynomial_rings/"
    },
    // ... one entry per built-in. Methods go in METHOD_DOCS below.
};

export const METHOD_DOCS: Record<string, SymbolDoc> = {
    // e.g. det, trace, rank, gen, subs ...
};
```

**Migration:** the existing `SAGEMATH_BUILTINS` / `SAGEMATH_METHODS` arrays stay as
the *enumeration order* for completion. The doc corpus is the *content*. For any
symbol without a full `SymbolDoc` entry yet, the renderer falls back to the old
single-line behavior, so the rollout is safe.

---

## 4. Rendering helpers (same module)

Two renderers, both producing Markdown (`MarkupKind.Markdown`):

```ts
export interface RenderOptions { verbosity: 'short' | 'full'; showExample: boolean; }

export function renderHoverMarkdown(doc: SymbolDoc, opts: RenderOptions): string;
export function renderCompletionMarkdown(doc: SymbolDoc, opts: RenderOptions): string;
```

`renderHoverMarkdown` output (full):

```markdown
**PolynomialRing** *(SageMath built-in — Rings)*

Construct a (multivariate) polynomial ring over `base_ring`.

Creates the ring of polynomials in one or more variables …

**Signature**
```sage
PolynomialRing(base_ring, name=None, names=None, *, order='degrevlex')
```

**Parameters**
| Name | Type | Description |
|------|------|-------------|
| `base_ring` | Ring | Coefficient ring, e.g. `QQ`, `ZZ`, `GF(7)`. |
| `name` | str | A single variable name, e.g. `'x'`. *(optional)* |

**Returns:** A `PolynomialRing_dense`/`MPolynomialRing` object.

**Example**
```sage
R = PolynomialRing(QQ, 'x')
x = R.gen()
f = x^2 + 1
```

[📖 SageMath docs](https://doc.sagemath.org/html/en/reference/polynomial_rings/)
```

`renderCompletionMarkdown` is the **short** form: signature + summary + (optionally)
example. The completion *details* popup is small, so we keep it compact; the full
text appears on hover.

`verbosity: 'short'` omits `description`, the params table, and `example`, keeping
just signature + summary + doc link — for users who want a compact hover.

## 5. Goal A — Longer documentation (concrete changes)

| File / location | Change |
|-----------------|--------|
| `server/src/symbolDocs.ts` (NEW) | `SymbolDoc`/`ParamDoc` types, `BUILTIN_DOCS`/`METHOD_DOCS` corpora, `renderHoverMarkdown`, `renderCompletionMarkdown`, plus the legacy one-line strings as fallbacks. |
| `server/src/server.ts` — top | `import { BUILTIN_DOCS, METHOD_DOCS, renderHoverMarkdown, renderCompletionMarkdown, getDocFor } from './symbolDocs';` Keep `SAGEMATH_BUILTINS`/`SAGEMATH_METHODS` as the completion enumeration list (or derive from `Object.keys(BUILTIN_DOCS)` for symbols that have docs, union the rest). |
| `server/src/server.ts` — `onCompletion` (~L462) | Set `item.detail = doc?.signature ?? 'SageMath built-in'` so the **completion list shows the argument list** next to each entry. Leave `documentation` light (filled on resolve). |
| `server/src/server.ts` — `onCompletionResolve` (~L504) | Replace the markdown with `renderCompletionMarkdown(doc, opts)` when a `SymbolDoc` exists; otherwise keep today's one-line behavior. |
| `server/src/server.ts` — `onHover` (~L521) | Use `renderHoverMarkdown(doc, opts)`. Keep the existing user-defined symbol block appended below. Honor `hoverVerbosity` / `hoverShowExamples` from settings. |
| `server/src/server.ts` — `SageMathSettings` (~L256) + `defaultSettings` (~L265) | Add `hoverVerbosity: 'short' \| 'full'` (default `'full'`) and `hoverShowExamples: boolean` (default `true`). Read them in `onHover`/`onCompletionResolve`. |
| `package.json` → `contributes.configuration.properties` | Add `sagemathEnhanced.hoverVerbosity` (enum) and `sagemathEnhanced.hoverShowExamples` (boolean) so they appear in Settings UI. |

> **VS Code rendering notes:** Hover renders full GFM Markdown including tables
> and fenced code blocks; long content scrolls inside the hover widget (there is
> no hard truncation). The completion *details* side-panel is smaller, so the
> completion renderer intentionally produces a compact form. Both re-use the same
> `SymbolDoc`, so there is no duplication.

---

## 6. Goal B — Display function arguments

Two complementary features give users argument awareness:

### 6.1 Signatures in the completion list (`detail`)

Already covered in §5: `item.detail = doc.signature`. The user sees
`PolynomialRing(base_ring, name=None, …)` directly in the suggestions list. **No
new LSP capability** required — purely a data wiring change.

### 6.2 Signature help (`textDocument/signatureHelp`) — the in-call parameter hints

This is the standard, expected UX for "display arguments of functions": when the
cursor is inside a call (`func(`) the editor shows a popup with the active
parameter highlighted, advancing as the user types commas.

**Step 1 — advertise the capability** in `server.ts` `onInitialize` (~L206):

```ts
capabilities: {
    // ... existing providers ...
    signatureHelpProvider: {
        triggerCharacters: ['(', ','],
        retriggerCharacters: [',']
    }
}
```

**Step 2 — implement the handler** (`vscode-languageserver` exports the types):

```ts
import { SignatureHelp, SignatureInformation, ParameterInformation } from 'vscode-languageserver/node';

// Parse the line up to the cursor to find which function is being called and
// which argument index the cursor is on. Handles nested () [] and ignores
// commas inside strings/brackets/comments.
function getCallContext(document, position): { callee: string; argIndex: number } | undefined;

connection.onSignatureHelp((params): SignatureHelp | undefined => {
    const document = documents.get(params.textDocument.uri);
    if (!document) { return undefined; }
    const ctx = getCallContext(document, params.position);
    if (!ctx) { return undefined; }

    const doc = BUILTIN_DOCS[ctx.callee] ?? METHOD_DOCS[ctx.callee];
    if (!doc?.params) { return undefined; }      // only symbols we know about

    const parameters = doc.params.map(p => ParameterInformation.create(
        p.default ? `${p.name}=${p.default}` : p.name,
        p.description
    ));

    const sig = SignatureInformation.create(doc.signature, doc.summary, ...parameters);
    sig.activeParameter = Math.min(ctx.argIndex, parameters.length - 1);
    sig.activeSignature = 0;

    return { signatures: [sig], activeSignature: 0, activeParameter: sig.activeParameter };
});
```

`getCallContext` algorithm (robust-enough for v1):
1. Take the text of the current line from column 0 to the cursor.
2. Walk backwards tracking depth over `() [] {}`, decrementing on closers and
   incrementing on openers; skip characters inside single/double quotes and after
   `#` (comment).
3. When depth first reaches `0 → 1` while scanning backwards, the token
   immediately left of that `(` (a `[A-Za-z_][\w.]*` match) is the `callee`.
4. `argIndex` = number of top-level (depth-1) commas between that `(` and the
   cursor (0-based).

This mirrors how most lightweight LSP servers implement signature help and is
sufficient for SageMath's call patterns.

### 6.3 (Optional) Snippet insert text for top functions

For a handful of high-traffic functions, set `CompletionItem.insertTextFormat =
SnippetText` and `insertText` to a snippet with tab stops mirroring the params,
e.g. `PolynomialRing(${1:base_ring}, name=${2:'x'})$0`. This makes `Tab` walk the
arguments. Keep it to ~10 functions to avoid noise; gated behind the existing
`enableCompletion` setting.

## 7. Phased rollout

**Phase 0 — Plumbing (no user-visible content change).**
Create `symbolDocs.ts` with types + renderers + a corpus seeded from today's
one-line strings (wrapped as `SymbolDoc` with only `summary`). Wire
`onCompletionResolve`/`onHover` to the new renderers with behaviour that
reproduces today's output exactly. Add signature-help capability + `getCallContext`
+ `onSignatureHelp` returning data from the corpus. Land unit tests.
**Outcome:** identical UX, but the machinery is in place.

**Phase 1 — Rich docs for top symbols.** Author full `SymbolDoc` entries for the
~20 most-used symbols: `PolynomialRing`, `matrix`, `vector`, `plot`, `GF`,
`NumberField`, `var`, `solve`, `factor`, `expand`, `simplify`, `diff`,
`integrate`, `limit`, `EllipticCurve`, `Graph`, `gcd`, `is_prime`,
`identity_matrix`, `diagonal_matrix`. Switch default `hoverVerbosity` to `'full'`.

**Phase 2 — Methods + coverage.** Fill `METHOD_DOCS` (`det`, `trace`, `rank`,
`gen`, `subs`, `nrows`, `characteristic`, …) and the remaining built-ins. Add
`docUrl` links pointing at the canonical SageMath reference pages.

**Phase 3 — Polish.** Snippet insert texts (§6.3), a possible `category`-based
grouping in completion `sortText`, and a hover setting to toggle the doc link.

---

## 8. Testing

Extend the existing LSP harness (`tests/test_lsp_completion.js`) and the unit
tests; no new framework needed.

- **Unit (pure functions):** in `src/test/` add tests for `renderHoverMarkdown`
  and `renderCompletionMarkdown` (signature present, params table rows, example
  block, verbosity switch, doc link) and for `getCallContext` (nested calls,
  commas in strings, comments). These run in plain Node — no VS Code needed.
- **LSP harness:** add `textDocument/hover` and `textDocument/signatureHelp`
  cases:
  - Hover over `PolynomialRing` → markdown contains the signature and the
    `base_ring` parameter.
  - Signature help at `matrix(|` → `activeParameter === 0`, one signature, with
    parameters populated.
  - Signature help at `plot(sin(x), (x, 0|,` → `activeParameter === 1`.
- **Manual:** in the Development Host, type `PolynomialRing(` and confirm the
  parameter popup; hover `matrix` for the rich card; open the completion list and
  confirm the `detail` column shows signatures.

Follow `docs/TESTING_AND_DEBUGGING.md` to run/debug these.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Markdown table/column rendering quirks in hover | Keep tables simple; escape `\|` in cell text; add a unit test snapshot. |
| `getCallContext` mis-parses complex expressions (slices, f-strings) | Return `undefined` on ambiguity (VS Code just hides the popup); refine incrementally. |
| Corpus authoring effort is large | Phased rollout; legacy one-line fallback means partial coverage never looks broken. |
| Bigger hover card annoys some users | Provide `hoverVerbosity: 'short'` and `hoverShowExamples` settings. |
| `server.ts` grows | All corpus + rendering lives in `symbolDocs.ts`; `server.ts` only imports. |
| Signature help fires too eagerly | Only return data for symbols present in the corpus; otherwise return `undefined`. |

---

## 10. Files touched (checklist)

- [ ] **NEW** `server/src/symbolDocs.ts` — types, corpora, renderers, `getCallContext`.
- [ ] `server/src/server.ts` — import; `onInitialize` adds `signatureHelpProvider`; `onCompletion` sets `detail`; `onCompletionResolve` + `onHover` use renderers; new `onSignatureHelp`; `SageMathSettings` + defaults.
- [ ] `package.json` — add `hoverVerbosity` and `hoverShowExamples` settings.
- [ ] `src/test/` — unit tests for renderers + `getCallContext`.
- [ ] `tests/test_lsp_completion.js` — hover + signatureHelp cases.
- [ ] `README.md`, `CHANGELOG.md` — document the new features & settings.

All compile targets are already covered by `tsconfig.json` (`include: ["src/**/*",
"server/src/**/*"]`), and the new JS output is automatically included by the
existing `.vscodeignore` rules, so no packaging changes are required.



