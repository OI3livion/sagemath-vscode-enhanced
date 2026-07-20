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
              "name"?: str, "text"?: str, "line"?: int (0-based), "col"?: int}
  response:  {"id": <int>, "result": {...}}

LSP sends 0-based line/col. Internally we convert to jedi's 1-based line.
"""
import json
import re
import sys

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
# Jedi-based operations
# ---------------------------------------------------------------------------

def _jedi_script(text):
    """Wrap user text with the sage prelude and build a Jedi Script."""
    if not JEDI_AVAILABLE:
        return None
    return jedi.Script(PRELUDE + (text or ""), path="/tmp/__sage_hover.sage")


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


def op_hover(text, line, col):
    """Hover at 0-based (line, col) in user text."""
    script = _jedi_script(text)
    if script is None:
        return {"empty": True}
    jline = line + 1 + PRELUDE_LINES
    # Try to infer the name under the cursor.
    try:
        names = script.infer(jline, col)
    except Exception:
        names = []
    if names:
        n = names[0]
        label, doc, sig = _name_doc_and_sig(n)
        if doc:
            return {"name": label, "doc": doc, "signature": sig,
                    "kind": n.type, "source": "jedi"}
    # Fallback: extract the word and resolve via getattr.
    word = _word_at(text, line, col)
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


def op_signatures(text, line, col):
    """Signature help at 0-based (line, col)."""
    script = _jedi_script(text)
    sigs_out = []
    if script is not None:
        jline = line + 1 + PRELUDE_LINES
        try:
            jsigs = script.get_signatures(jline, col)
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
    # Fallback via getattr on the callee word.
    if not sigs_out:
        word = _word_at(text, line, col)
        # Walk back to the callee before the '('.
        callee = _callee_before(text, line, col)
        if callee:
            r = op_lookup(callee)
            if r and r.get("doc") is not None and not r.get("error"):
                label = _format_signature(callee, r)
                args = r.get("args") or []
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


def op_complete(text, line, col):
    """Completions at 0-based (line, col)."""
    script = _jedi_script(text)
    items = []
    if script is not None:
        jline = line + 1 + PRELUDE_LINES
        try:
            comps = script.complete(jline, col)
        except Exception:
            comps = []
        for c in comps[:200]:
            items.append({
                "label": c.name,
                "kind": c.type,
                "detail": "",
                "doc": (c.docstring(raw=True) or "")[:4000],
                "complete": c.complete,
            })
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
                result = op_hover(req.get("text", ""), req.get("line", 0), req.get("col", 0))
            elif op == "signatures":
                result = op_signatures(req.get("text", ""), req.get("line", 0), req.get("col", 0))
            elif op == "complete":
                result = op_complete(req.get("text", ""), req.get("line", 0), req.get("col", 0))
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


