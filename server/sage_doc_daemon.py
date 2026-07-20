#!/usr/bin/env sage -python
"""
SageMath documentation daemon for the SageMath Enhanced language server.

Line-delimited JSON over stdio:
  request:  {"id": <int>, "name": "<symbol>" | "method:<name>"}
  response: {"id": <int>, "result": {doc, args, varargs, keywords, defaults,
                                     file, callable}}
            or {"id": <int>, "result": {"error": "..."}}

On startup it prints one handshake line:
  {"ready": true, "sage": <bool>, "error": <str|null>}

Safety: only names present in ALLOWLIST are ever evaluated, so this is safe to
run against untrusted editor content -- we never eval document text.

Launch with:   sage -python sage_doc_daemon.py
"""
import json
import sys

try:
    from sage.all import *  # noqa: F401,F403  (populates module globals)
    from sage.misc.sageinspect import (  # noqa: F401
        sage_getdoc,
        sage_getargspec,
        sage_getfile,
    )
    SAGE_AVAILABLE = True
    STARTUP_ERROR = None
except Exception as exc:  # sage not installed / import failed
    SAGE_AVAILABLE = False
    STARTUP_ERROR = "%s: %s" % (type(exc).__name__, exc)
    sage_getdoc = sage_getargspec = sage_getfile = None
BUILTIN_LIST = [
    # Rings and Fields
    'ZZ', 'QQ', 'RR', 'CC', 'GF', 'Zmod', 'PolynomialRing', 'NumberField',
    'LaurentPolynomialRing', 'PowerSeriesRing', 'FractionField', 'QuotientRing',
    'FiniteField', 'CyclotomicField', 'QuaternionAlgebra', 'MatrixAlgebra',
    # Basic functions
    'var', 'vars', 'SR', 'solve', 'factor', 'expand', 'simplify', 'diff', 'integrate',
    # Polynomial operations
    'Polynomial', 'poly', 'polynomial', 'polygen', 'PolynomialQuotientRing',
    # Linear algebra
    'matrix', 'vector', 'identity_matrix', 'zero_matrix', 'ones_matrix',
    'random_matrix', 'diagonal_matrix', 'block_matrix',
    # Plotting
    'plot', 'plot3d', 'parametric_plot', 'parametric_plot3d', 'implicit_plot',
    'list_plot', 'scatter_plot', 'contour_plot',
    # Number theory
    'gcd', 'lcm', 'is_prime', 'next_prime', 'prime_range', 'factorial',
    'euler_phi', 'divisors', 'prime_divisors', 'factor_trial_division',
    'legendre_symbol', 'jacobi_symbol', 'kronecker_symbol', 'quadratic_residues',
    'continued_fraction', 'convergents', 'nth_prime', 'prime_pi', 'discrete_log',
    # Lattice algorithms
    'LLL', 'BKZ', 'hermite_form', 'smith_form',
    # Combinatorics
    'Permutations', 'Combinations', 'Partitions', 'binomial',
    'catalan_number', 'fibonacci', 'lucas_number', 'stirling_number1', 'stirling_number2',
    # Graph theory
    'Graph', 'DiGraph', 'graphs',
    # Geometry
    'Point', 'Line', 'Circle', 'Polygon', 'Polyhedron',
    # Calculus
    'limit', 'taylor', 'series', 'laplace', 'inverse_laplace',
    'derivative', 'integral', 'sum', 'product', 'fourier_transform',
    'laplace_transform', 'symbolic_sum', 'symbolic_product',
    # Cryptography
    'RSA', 'ElGamal', 'DiffieHellman', 'AES', 'DES',
    # Elliptic curves
    'EllipticCurve', 'EllipticCurve_from_j',
    # Probability
    'random', 'randint', 'choice', 'shuffle',
    # Special functions
    'sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'abs', 'floor', 'ceil',
    'gamma', 'beta', 'zeta', 'bessel_J', 'bessel_Y',
    # Constants
    'pi', 'e', 'I', 'infinity', 'oo', 'NaN', 'golden_ratio',
]

METHOD_LIST = [
    'parent', 'base_ring', 'characteristic', 'degree', 'gen', 'gens',
    'nrows', 'ncols', 'rank', 'det', 'trace', 'transpose', 'inverse',
    'eigenvalues', 'eigenvectors', 'charpoly', 'minimal_polynomial',
    'norm', 'conjugate', 'real_part', 'imag_part', 'numerator', 'denominator',
    'collect', 'coefficient', 'substitute', 'subs', 'variables',
    'is_zero', 'is_one', 'is_unit', 'is_nilpotent', 'is_invertible',
    'save', 'load', 'show', 'latex', 'pretty_print',
]

ALLOWLIST = set(BUILTIN_LIST) | set(METHOD_LIST)

# Host objects used to introspect method names. Sage methods are bound to
# parents/elements, so e.g. `.det` must be looked up on a real matrix.
_METHOD_HOSTS = None


def _method_hosts():
    global _METHOD_HOSTS
    if _METHOD_HOSTS is not None:
        return _METHOD_HOSTS
    hosts = []
    try:
        hosts.append(MatrixSpace(ZZ, 2).one())  # noqa: F405
    except Exception:
        pass
    try:
        hosts.append(QQ['x'].gen())  # noqa: F405
    except Exception:
        pass
    try:
        hosts.append(vector(QQ, [1, 2, 3]))  # noqa: F405
    except Exception:
        pass
    try:
        hosts.append(ZZ(5))  # noqa: F405
    except Exception:
        pass
    try:
        hosts.append(SR.var('x'))  # noqa: F405
    except Exception:
        pass
    _METHOD_HOSTS = hosts
    return hosts
def _resolve(name):
    # Caller guarantees name is in ALLOWLIST. `from sage.all import *` put the
    # sage symbols in module globals; eval also sees Python builtins via the
    # auto-inserted __builtins__.
    return eval(name, globals())  # noqa: S307 - name is allowlisted


def _resolve_method(name):
    for host in _method_hosts():
        try:
            obj = getattr(host, name, None)
            if obj is not None:
                return obj
        except Exception:
            continue
    raise AttributeError("method not found on any host: %s" % name)


def _doc_for(obj):
    """Common doc/argspec extraction for a resolved object."""
    out = {}
    try:
        doc = sage_getdoc(obj)
        out["doc"] = doc if isinstance(doc, str) else ""
    except Exception:
        out["doc"] = ""
    try:
        spec = sage_getargspec(obj)
        out["args"] = list(getattr(spec, "args", []) or [])
        out["varargs"] = getattr(spec, "varargs", None)
        out["keywords"] = getattr(spec, "keywords", None)
        defaults = getattr(spec, "defaults", None)
        # repr() the defaults so JSON can serialise arbitrary Sage objects.
        out["defaults"] = [repr(d) for d in defaults] if defaults else []
    except Exception:
        out["args"] = None
    out["callable"] = bool(callable(obj))
    return out


def lookup(name):
    if not SAGE_AVAILABLE:
        return {"error": "sage not available", "startup_error": STARTUP_ERROR}
    if name not in ALLOWLIST:
        return {"error": "not in allowlist: %s" % name}
    try:
        obj = _resolve(name)
    except Exception as exc:
        return {"error": "resolve: %s" % exc}
    result = _doc_for(obj)
    try:
        f = sage_getfile(obj)
        result["file"] = f if isinstance(f, str) else ""
    except Exception:
        pass
    return result


def main():
    # Handshake: tells the supervisor whether sage loaded.
    sys.stdout.write(json.dumps({
        "ready": True,
        "sage": SAGE_AVAILABLE,
        "error": STARTUP_ERROR,
    }))
    sys.stdout.write("\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        name = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            name = req.get("name")
        except Exception as exc:
            sys.stdout.write(json.dumps({"id": None, "result": {"error": "bad json: %s" % exc}}))
            sys.stdout.write("\n")
            sys.stdout.flush()
            continue
        if not isinstance(name, str):
            sys.stdout.write(json.dumps({"id": rid, "result": {"error": "missing name"}}))
            sys.stdout.write("\n")
            sys.stdout.flush()
            continue
        # method:<name> convention resolves the method on a host object.
        if name.startswith("method:"):
            real = name.split(":", 1)[1]
            if not SAGE_AVAILABLE:
                result = {"error": "sage not available", "startup_error": STARTUP_ERROR}
            elif real not in ALLOWLIST:
                result = {"error": "not in allowlist: %s" % real}
            else:
                try:
                    result = _doc_for(_resolve_method(real))
                except Exception as exc:
                    result = {"error": "method: %s" % exc}
        else:
            result = lookup(name)
        sys.stdout.write(json.dumps({"id": rid, "result": result}))
        sys.stdout.write("\n")
        sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass


