#!/usr/bin/env python
"""
SageMath documentation/analysis daemon for the SageMath Enhanced language server.

Engine: Jedi (static analysis) primary, with a safe getattr-on-sage.all
fallback for symbols Jedi cannot see (Cython .pyx sources, singletons like ZZ).

NO eval, NO allowlist, NO arbitrary code execution from editor text:
  - Jedi parses source; it never runs user code.
  - The getattr fallback only resolves validated dotted identifiers against the
    already-imported sage.all module (exactly what `import` does), with a strict
    identifier regex and a no-dunder guard.

Line-delimited JSON over stdio:
  handshake: {"ready": true, "sage": <bool>, "jedi": <bool>, "error": null|str}
  request:   {"id": <int>, "op": "lookup"|"hover"|"signatures"|"complete",
              "name"?: str, "text"?: str, "line"?: int (0-based), "col"?: int,
              "path"?: str (filesystem path of the document, for jedi import
              resolution of sibling modules)}
  response:  {"id": <int>, "result": {...}}

LSP sends 0-based line/col. Internally we convert to jedi's 1-based line.

.sage text is NOT valid Python ('^', 'R.<x> = ...', '[1..n]', 'f(x) = ...').
Before any ast.parse / jedi analysis we run it through sage's preparser
(sage.repl.preparse), which is line-preserving, and map cursor columns by
preparsing the current line prefix (literals expand: '2^3' becomes
'Integer(2)**Integer(3)'). Without this, one sage-specific line kills the
whole namespace sync (ast.parse hard-fails) and degrades jedi.
"""
import json
import re
import sys
import ast
import threading

STARTUP_ERROR = None
SAGE_AVAILABLE = False
JEDI_AVAILABLE = False
try:
    import sage.all  # noqa: F401  (makes sage importable / populates namespace)
    SAGE_AVAILABLE = True
except Exception as exc:
    STARTUP_ERROR = "sage: %s: %s" % (type(exc).__name__, exc)

try:
    import jedi
    JEDI_AVAILABLE = True
except Exception as exc:
    if STARTUP_ERROR:
        STARTUP_ERROR += "; jedi: %s" % exc
    else:
        STARTUP_ERROR = "jedi: %s: %s" % (type(exc).__name__, exc)

import inspect
_SAGE_GETARGSPEC = None
if SAGE_AVAILABLE:
    try:
        from sage.misc.sageinspect import sage_getargspec as _SAGE_GETARGSPEC
    except Exception:
        pass

# Sage's preparser: converts .sage source to valid Python. Only importable in
# the sage environment; everything that uses it degrades to raw text without it.
try:
    from sage.repl.preparse import preparse as _sage_preparse
except Exception:
    _sage_preparse = None

# A synthetic prelude prepended to user text so Jedi treats the document as a
# sage session (sage files implicitly have the sage.all namespace). Adds 1 line,
# so a 0-based LSP line L maps to jedi line L + 2.
PRELUDE = "from sage.all import *\n"
PRELUDE_LINES = 1

# Strict dotted-identifier guard for the getattr fallback. Rejects anything with
# quotes, brackets, operators, or dunders -- so it can never become code.
_IDENT = re.compile(r"^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$")


def _is_safe_name(name):
    if not name or not _IDENT.match(name):
        return False
    return "__" not in name  # no dunder access


def _safe_resolve(name):
    """getattr-chain on sage.all. Returns (obj, None) or (None, error)."""
    if not SAGE_AVAILABLE:
        return None, "sage not available"
    if not _is_safe_name(name):
        return None, "not a safe identifier: %r" % name
    obj = sage.all
    try:
        for part in name.split("."):
            obj = getattr(obj, part)
        return obj, None
    except Exception as exc:
        return None, "resolve %r: %s" % (name, exc)


def _preparse(text):
    """Convert .sage source to valid Python via sage's preparser.

    Falls back to the raw text when the preparser is unavailable, raises, or
    changes the line count (line preservation is required for position
    mapping; it holds for all standard sage constructs).
    """
    text = text or ""
    if _sage_preparse is None:
        return text
    try:
        out = _sage_preparse(text)
    except Exception:
        return text
    if len(out.splitlines()) != len(text.splitlines()):
        return text
    return out


def _map_col(line_text, col):
    """Map a cursor column in a raw .sage line to the matching column in the
    preparsed line, by preparsing the line prefix (preparse is line-local;
    literals expand, e.g. '2^3' -> 'Integer(2)**Integer(3)')."""
    if _sage_preparse is None:
        return col
    try:
        return len(_sage_preparse(line_text[:col]))
    except Exception:
        return col


def _mapped_jedi_position(text, line, col):
    """(0-based line, col) over raw text -> (1-based line, col) over the
    preparsed+prelude text jedi sees."""
    lines = (text or "").split("\n")
    raw_line = lines[line] if 0 <= line < len(lines) else ""
    return line + 1 + PRELUDE_LINES, _map_col(raw_line, col)


def _signature_of(obj):
    """Return (args, varargs, keywords, defaults) or (None, None, None, [])."""
    # 1. stdlib inspect.signature (works for pure-Python and many Cython funcs)
    try:
        sig = inspect.signature(obj)
        args, varargs, keywords, defaults = [], None, None, []
        for pname, p in sig.parameters.items():
            k = p.kind
            if k == p.POSITIONAL_OR_KEYWORD or k == p.KEYWORD_ONLY:
                args.append(pname)
                if p.default is not p.empty:
                    defaults.append(repr(p.default))
            elif k == p.VAR_POSITIONAL:
                varargs = pname
            elif k == p.VAR_KEYWORD:
                keywords = pname
        return args, varargs, keywords, defaults
    except (ValueError, TypeError):
        pass
    # 2. sage_getargspec fallback (works on Cython classes/singletons)
    if _SAGE_GETARGSPEC is not None:
        try:
            spec = _SAGE_GETARGSPEC(obj)
            a = list(getattr(spec, "args", []) or [])
            # strip leading 'self' for bound methods
            if a and a[0] == "self":
                a = a[1:]
            d = getattr(spec, "defaults", None)
            d = [repr(x) for x in d] if d else []
            return a, getattr(spec, "varargs", None), getattr(spec, "keywords", None), d
        except Exception:
            pass
    return None, None, None, []


def _doc_of(obj):
    d = getattr(obj, "__doc__", None)
    return d if isinstance(d, str) else ""


def _result_for_obj(obj, source):
    """Build the lookup-shaped result for a live object."""
    doc = _doc_of(obj)
    args, varargs, keywords, defaults = _signature_of(obj)
    return {
        "doc": doc,
        "args": args,
        "varargs": varargs,
        "keywords": keywords,
        "defaults": defaults,
        "callable": callable(obj),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Document namespace: AST-validated execution of simple assignments + imports
# so completion/hover work on constructed objects (M = matrix(...) -> M.det).
# Gated by enableLiveNamespace (the TS side sends sync_namespace only when on).
# ---------------------------------------------------------------------------

_UNSAFE_CALLS = {"eval", "exec", "compile", "__import__", "globals",
                 "locals", "vars", "getattr", "setattr", "delattr"}

_ALLOWED_EXPR_NODES = (
    ast.Call, ast.Name, ast.Attribute, ast.Constant,
    ast.BinOp, ast.UnaryOp, ast.Tuple, ast.List, ast.Set, ast.Dict,
    ast.keyword, ast.arg, ast.Load,
    ast.FormattedValue, ast.JoinedStr,
)
# Backwards-compat aliases deprecated in 3.8, removed in 3.14 (Constant unifies
# Num/Str/Bytes/NameConstant/Ellipsis). Add them only if present.
for _legacy in ('Num', 'Str', 'Bytes', 'NameConstant', 'Ellipsis'):
    if hasattr(ast, _legacy):
        _ALLOWED_EXPR_NODES += (getattr(ast, _legacy),)


def _attr_is_visible(attr):
    """Attributes the namespace may read: public ones, plus sage's preparsed
    generator-unpacking hook `_first_ngens` (emitted for `R.<x> = ...`; a
    benign read-only constructor helper on rings)."""
    return not attr.startswith("_") or attr == "_first_ngens"


def _rhs_is_safe(node):
    """Recursively check that an assignment RHS only uses allowed constructs."""
    # Operator/comparator marker nodes (ast.Add, ast.USub, ast.Eq, etc.) are
    # always safe -- they carry no code, just the operation type.
    if isinstance(node, (ast.operator, ast.unaryop, ast.cmpop, ast.boolop)):
        return True
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name) and node.func.id in _UNSAFE_CALLS:
            return False
        if isinstance(node.func, ast.Attribute) and not _attr_is_visible(node.func.attr):
            return False
    elif isinstance(node, ast.Attribute):
        if not _attr_is_visible(node.attr):
            return False
    elif isinstance(node, ast.Subscript):
        if not _rhs_is_safe(node.value):
            return False
        sl = node.slice
        if isinstance(sl, ast.Slice):
            return False
        if isinstance(sl, ast.Index):  # pragma: no cover (py<3.9)
            sl = sl.value
        return _rhs_is_safe(sl)
    elif isinstance(node, ast.keyword):
        if node.arg is not None and node.arg.startswith("_"):
            return False
        return _rhs_is_safe(node.value) if node.value is not None else True
    if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
        return False
    if isinstance(node, (ast.Starred, ast.Await, ast.Yield, ast.YieldFrom,
                         ast.Lambda, ast.IfExp, ast.NamedExpr)):
        return False
    if not isinstance(node, _ALLOWED_EXPR_NODES):
        return False
    for child in ast.iter_child_nodes(node):
        if not _rhs_is_safe(child):
            return False
    return True


def _statement_is_eligible(stmt):
    """Return (kind, info) for an executable statement, or (None, None)."""
    if isinstance(stmt, (ast.Import, ast.ImportFrom)):
        return ("import", [(a.asname or a.name, None) for a in stmt.names])
    if isinstance(stmt, ast.Assign):
        targets = []
        for t in stmt.targets:
            if isinstance(t, ast.Name):
                targets.append(t.id)
            elif (isinstance(t, (ast.Tuple, ast.List))
                  and all(isinstance(e, ast.Name) for e in t.elts)):
                # Tuple unpacking of plain names, e.g. the preparsed form of
                # R.<x,y> = ... : (x, y,) = R._first_ngens(2)
                targets.extend(e.id for e in t.elts)
            else:
                return (None, None)
        if not _rhs_is_safe(stmt.value):
            return (None, None)
        return ("assign", (targets, stmt.value))
    if isinstance(stmt, ast.AnnAssign):
        if not isinstance(stmt.target, ast.Name) or stmt.value is None:
            return (None, None)
        if not _rhs_is_safe(stmt.value):
            return (None, None)
        return ("assign", ([stmt.target.id], stmt.value))
    return (None, None)


# The live document namespace: name -> live object. Populated by sync_namespace.
_NAMESPACE = {}
_NAMESPACE_LOCK = threading.Lock()
# Hash of the statement set currently materialised, so unchanged syncs are no-ops.
_NAMESPACE_HASH = None


def sync_namespace(text, timeout=2.0, enabled=True):
    """Rebuild _NAMESPACE from `text` by executing eligible statements.

    Safe by construction: only Import/ImportFrom and simple-Name assignments
    whose RHS passes _rhs_is_safe are executed, each in try/except, each with a
    per-statement timeout. Gated by the enableLiveNamespace setting.
    """
    global _NAMESPACE_HASH
    if not enabled or not SAGE_AVAILABLE:
        return {"synced": False, "reason": "disabled" if not enabled else "no sage"}
    try:
        # Preparse so sage syntax (R.<x> = ..., ^, [1..n]) doesn't hard-fail
        # the whole sync -- ast.parse is not error-tolerant, one bad line used
        # to kill completion for every constructed object in the document.
        tree = ast.parse(_preparse(text))
    except SyntaxError:
        return {"synced": False, "reason": "syntax error"}  # mid-typing: keep ns
    except Exception as exc:
        return {"synced": False, "reason": "parse: %s" % exc}

    eligible = [ast.dump(s) for s in tree.body if _statement_is_eligible(s)[0]]
    import hashlib
    h = hashlib.sha1(repr(eligible).encode("utf-8")).hexdigest()
    if h == _NAMESPACE_HASH:
        return {"synced": True, "changed": False, "names": len(_NAMESPACE)}

    ns = {"__name__": "__sage_namespace__"}
    try:
        for k in dir(sage.all):
            if not k.startswith("_"):
                ns[k] = getattr(sage.all, k)
    except Exception:
        pass
    executed, failed = 0, 0
    for stmt in tree.body:
        if _statement_is_eligible(stmt)[0] is None:
            continue
        try:
            code = compile(ast.Module(body=[stmt], type_ignores=[]),
                           "<namespace>", "exec")
        except Exception:
            failed += 1
            continue
        result = {}

        def _run(code=code, ns=ns):
            try:
                exec(code, ns)  # noqa: S102 - gated by AST validation + setting
                result["ok"] = True
            except Exception as exc:
                result["ok"] = False
                result["err"] = "%s" % exc

        th = threading.Thread(target=_run, daemon=True)
        th.start()
        th.join(timeout)
        if th.is_alive() or not result.get("ok"):
            failed += 1
            continue
        executed += 1
    with _NAMESPACE_LOCK:
        _NAMESPACE.clear()
        # Imported modules are kept: dir() on them is the runtime fallback for
        # module completion (np., os., local helpers) when jedi's stubs fall
        # short. Executing imports is already part of the trust model.
        for k, v in ns.items():
            if not k.startswith("_"):
                _NAMESPACE[k] = v
        _NAMESPACE_HASH = h
    return {"synced": True, "changed": True, "executed": executed,
            "failed": failed, "names": len(_NAMESPACE)}


def _resolve_in_namespace(name):
    """Resolve a bare/dotted name against the live namespace first, then
    sage.all. Returns (obj, source) or (None, None)."""
    if not name:
        return None, None
    parts = name.split(".")
    base = parts[0]
    obj = None
    in_ns = False
    with _NAMESPACE_LOCK:
        if base in _NAMESPACE:
            obj = _NAMESPACE[base]
            in_ns = True
    if obj is None:
        obj, _ = _safe_resolve(base)
        if obj is None:
            return None, None
    try:
        for p in parts[1:]:
            if p.startswith("_"):
                return None, None
            obj = getattr(obj, p)
    except Exception:
        return None, None
    return obj, ("namespace" if in_ns else "getattr")


def _dir_completion(obj, prefix=""):
    """Build completion items from dir(obj), filtered + paired with doc summary."""
    items = []
    try:
        names = dir(obj)
    except Exception:
        return items
    for name in names:
        if name.startswith("_"):
            continue
        if prefix and not name.lower().startswith(prefix.lower()):
            continue
        try:
            attr = getattr(obj, name)
        except Exception:
            continue
        doc = _doc_of(attr)
        summary = doc.strip().split("\n", 1)[0][:200] if doc else ""
        kind = "method" if callable(attr) else "property"
        items.append({
            "label": name, "kind": kind, "detail": kind,
            "doc": summary, "complete": name,
        })
    return items


# ---------------------------------------------------------------------------
# Jedi-based operations
# ---------------------------------------------------------------------------

def _jedi_script(text, path=None):
    """Wrap user text (preparsed to valid Python) with the sage prelude and
    build a Jedi Script.

    `path` is the document's real filesystem path: jedi uses its directory
    for import resolution, so sibling modules (`import helper` sitting next
    to the .sage file) resolve -- the old /tmp fallback hid them.
    """
    if not JEDI_AVAILABLE:
        return None
    return jedi.Script(PRELUDE + _preparse(text),
                       path=path or "/tmp/__sage_hover.sage")


def _name_doc_and_sig(name_obj):
    """Extract doc + signature from a Jedi Name via its definitions."""
    doc = name_obj.docstring(raw=True) or ""
    label = name_obj.name or ""
    # Try to get a signature string from jedi.
    sig_str = ""
    try:
        sig_str = name_obj.get_signatures()[0].to_string() if name_obj.get_signatures() else ""
    except Exception:
        pass
    return label, doc, sig_str


def op_lookup(name):
    """Resolve a bare/dotted name. Jedi first, safe getattr fallback."""
    # 1. Jedi on a synthetic document.
    if JEDI_AVAILABLE:
        try:
            code = PRELUDE + (name.split(".")[0] if name else "") + "\n"
            script = jedi.Script(code, path="/tmp/__sage_lookup.sage")
            line = PRELUDE_LINES + 1
            col = 0
            # For dotted names, walk the attribute access.
            base = name.split(".")[0]
            names = script.infer(line, len(base))
            if names:
                n = names[0]
                # For dotted names, try to descend.
                obj_names = [n]
                for part in name.split(".")[1:]:
                    descended = []
                    for on in obj_names:
                        try:
                            descended.extend(on.goto(part))
                        except Exception:
                            pass
                    obj_names = descended
                    if not obj_names:
                        break
                target = obj_names[0] if obj_names else n
                doc = target.docstring(raw=True) or ""
                if doc:
                    # Build signature from jedi signatures if available.
                    args, varargs, keywords, defaults = None, None, None, []
                    try:
                        sigs = target.get_signatures()
                        if sigs:
                            s = sigs[0].to_string()
                            # crude parse: Name(a, b=c) -> args
                            inner = s[s.find("(") + 1 : s.rfind(")")] if "(" in s else ""
                            args = [p.strip() for p in inner.split(",") if p.strip()] if inner else []
                    except Exception:
                        pass
                    return {
                        "doc": doc, "args": args, "varargs": varargs,
                        "keywords": keywords, "defaults": defaults,
                        "callable": (target.type in ("function", "class", "method")),
                        "source": "jedi",
                    }
        except Exception:
            pass
    # 2. Safe getattr fallback (covers Cython symbols like ZZ).
    obj, err = _safe_resolve(name)
    if obj is not None:
        return _result_for_obj(obj, "getattr")
    return {"error": err or "not found", "doc": "", "source": ""}


def op_hover(text, line, col, path=None):
    """Hover at 0-based (line, col) in user text."""
    script = _jedi_script(text, path)
    if script is None:
        return {"empty": True}
    jline, jcol = _mapped_jedi_position(text, line, col)
    # 1. Live namespace first (constructed objects + dotted attributes).
    word = _word_at(text, line, col)
    if word:
        recv, src = _resolve_in_namespace(word)
        if recv is not None:
            r = _result_for_obj(recv, src or "namespace")
            sig = _format_signature(word, r)
            return {"name": word, "doc": r["doc"], "signature": sig,
                    "kind": type(recv).__name__, "source": src or "namespace"}
    # 2. Jedi infer.
    try:
        names = script.infer(jline, jcol)
    except Exception:
        names = []
    if names:
        n = names[0]
        label, doc, sig = _name_doc_and_sig(n)
        if doc:
            return {"name": label, "doc": doc, "signature": sig,
                    "kind": n.type, "source": "jedi"}
    # 3. getattr-on-sage.all fallback.
    if word:
        obj, err = _safe_resolve(word)
        if obj is not None:
            r = _result_for_obj(obj, "getattr")
            sig = _format_signature(word, r)
            return {"name": word, "doc": r["doc"], "signature": sig,
                    "kind": type(obj).__name__, "source": "getattr"}
    return {"empty": True}
def _word_at(text, line, col):
    """Return the dotted identifier covering (line, col), scanning both
    directions from the cursor (LSP positions the cursor inside the word)."""
    if not text:
        return ""
    lines = text.split("\n")
    if line < 0 or line >= len(lines):
        return ""
    row = lines[line]
    if col < 0:
        col = 0
    if col > len(row):
        col = len(row)
    start = col
    while start > 0 and (row[start - 1].isalnum() or row[start - 1] in "_."):
        start -= 1
    end = col
    while end < len(row) and (row[end].isalnum() or row[end] in "_."):
        end += 1
    return row[start:end].strip(".")


def _format_signature(name, result):
    """Build a 'Name(arg, kw=default)' string from a lookup result."""
    args = list(result.get("args") or [])
    if result.get("varargs"):
        args.append("*" + result["varargs"])
    if result.get("keywords"):
        args.append("**" + result["keywords"])
    defaults = result.get("defaults") or []
    offset = len(args) - len(defaults)
    rendered = []
    for i, a in enumerate(args):
        if a.startswith("*"):
            rendered.append(a)
            continue
        di = i - offset
        if 0 <= di < len(defaults):
            rendered.append("%s=%s" % (a, defaults[di]))
        else:
            rendered.append(a)
    return "%s(%s)" % (name, ", ".join(rendered))


def op_signatures(text, line, col, path=None):
    """Signature help at 0-based (line, col)."""
    script = _jedi_script(text, path)
    sigs_out = []
    if script is not None:
        jline, jcol = _mapped_jedi_position(text, line, col)
        try:
            jsigs = script.get_signatures(jline, jcol)
        except Exception:
            jsigs = []
        for s in jsigs[:1]:
            params = []
            try:
                params = [{"name": p.name, "default": ""} for p in s.params]
            except Exception:
                pass
            sigs_out.append({
                "label": s.to_string(),
                "params": params,
                "active_parameter": s.index if s.index is not None else 0,
            })
    # Fallback: resolve the callee via the namespace first, then getattr lookup.
    if not sigs_out:
        callee = _callee_before(text, line, col)
        if callee:
            # 1. Live namespace (constructed objects' methods: M.method()
            recv, src = _resolve_in_namespace(callee)
            if recv is None:
                # 2. Top-level name lookup
                r = op_lookup(callee)
                if r and r.get("doc") is not None and not r.get("error"):
                    recv_r = r
                else:
                    recv_r = None
            else:
                recv_r = _result_for_obj(recv, src or "namespace")
            if recv_r:
                label = _format_signature(callee, recv_r)
                args = recv_r.get("args") or []
                params = [{"name": a, "default": ""} for a in args]
                sigs_out.append({"label": label, "params": params, "active_parameter": 0})
    return {"signatures": sigs_out}


def _callee_before(text, line, col):
    """Find the callee identifier immediately before the '(' enclosing col."""
    if not text:
        return ""
    flat = text.split("\n")
    if line >= len(flat):
        return ""
    # Concatenate up to the cursor and scan back for '('.
    before = "\n".join(flat[:line + 1])
    before = before[: sum(len(x) + 1 for x in flat[:line]) + col] if line > 0 else flat[0][:col]
    depth = 0
    i = len(before) - 1
    while i >= 0:
        c = before[i]
        if c == ")":
            depth += 1
        elif c == "(":
            if depth == 0:
                j = i - 1
                while j >= 0 and before[j].isspace():
                    j -= 1
                end = j + 1
                m = re.search(r"([A-Za-z_]\w*(\.[A-Za-z_]\w*)*)$", before[:end])
                return m.group(1) if m else ""
            depth -= 1
        i -= 1
    return ""


def _jedi_completion_items(script, jline, jcol, seen, limit=500):
    """Jedi completions at a position as item dicts, skipping labels already
    in `seen` (runtime dir() items win -- they are the ground truth)."""
    items = []
    try:
        comps = script.complete(jline, jcol)
    except Exception:
        return items
    for c in comps:
        if len(items) >= limit:
            break
        if c.name in seen:
            continue
        seen.add(c.name)
        items.append({
            "label": c.name, "kind": c.type, "detail": "",
            "doc": (c.docstring(raw=True) or "")[:4000], "complete": c.complete,
        })
    return items


def op_complete(text, line, col, path=None):
    """Completions at 0-based (line, col).

    Dotted receivers: MERGE the live namespace (runtime ground truth via
    dir()) with jedi's static completions -- neither alone is complete. Jedi
    cannot infer sage/numpy constructor return types (M., A. -> 0 items),
    while dir() can miss type-level descriptors that raise at runtime.
    Dedupe by label, namespace first. Non-dotted: jedi only (general
    completion is handled TS-side).
    """
    script = _jedi_script(text, path)
    jline, jcol = _mapped_jedi_position(text, line, col)
    items = []
    seen = set()
    # Determine the dotted receiver (e.g. "M." or "obj.par") from the line.
    line_text = (text or "").split("\n")[line] if text and line < len(text.split("\n")) else ""
    left = line_text[:col] if col <= len(line_text) else line_text
    dotted_match = re.search(r"([A-Za-z_]\w*(\.[A-Za-z_]\w*)*)\.\s*([A-Za-z_]?\w*)$", left)
    if dotted_match:
        recv_name = dotted_match.group(1)
        prefix = dotted_match.group(3)
        # 1. Live namespace (constructed objects: M = matrix(...))
        recv, src = _resolve_in_namespace(recv_name)
        if recv is not None:
            for it in _dir_completion(recv, prefix):
                if it["label"] not in seen:
                    seen.add(it["label"])
                    items.append(it)
        # 2. Jedi on the dotted position (adds anything dir() missed)
        if script is not None:
            items.extend(_jedi_completion_items(script, jline, jcol, seen,
                                                limit=max(0, 500 - len(items))))
        return {"items": items[:500]}
    # Non-dotted context: jedi only (general completion is handled TS-side).
    if script is not None:
        items.extend(_jedi_completion_items(script, jline, jcol, seen))
    return {"items": items}


def main():
    sys.stdout.write(json.dumps({
        "ready": True,
        "sage": SAGE_AVAILABLE,
        "jedi": JEDI_AVAILABLE,
        "error": STARTUP_ERROR,
    }))
    sys.stdout.write("\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            op = req.get("op")
        except Exception as exc:
            sys.stdout.write(json.dumps({"id": None, "result": {"error": "bad json: %s" % exc}}))
            sys.stdout.write("\n"); sys.stdout.flush(); continue
        try:
            if op == "lookup":
                result = op_lookup(req.get("name", ""))
            elif op == "hover":
                result = op_hover(req.get("text", ""), req.get("line", 0),
                                  req.get("col", 0), path=req.get("path"))
            elif op == "signatures":
                result = op_signatures(req.get("text", ""), req.get("line", 0),
                                       req.get("col", 0), path=req.get("path"))
            elif op == "complete":
                result = op_complete(req.get("text", ""), req.get("line", 0),
                                     req.get("col", 0), path=req.get("path"))
            elif op == "sync_namespace":
                result = sync_namespace(req.get("text", ""), enabled=bool(req.get("enabled", True)))
            else:
                result = {"error": "unknown op: %r" % op}
        except Exception as exc:
            result = {"error": "%s: %s" % (type(exc).__name__, exc)}
        sys.stdout.write(json.dumps({"id": rid, "result": result}))
        sys.stdout.write("\n")
        sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass


