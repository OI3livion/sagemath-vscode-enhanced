#!/usr/bin/env python3
"""Unit tests for the daemon's sage preparse layer.

Tests _preparse / _map_col / _mapped_jedi_position from sage_doc_daemon.py,
plus the end-to-end effect on sync_namespace (sage syntax must no longer
kill the live namespace).

Preparse-dependent checks are SKIPPED when sage is not importable (e.g. plain
python3 CI); fallback-behavior checks always run.
"""
import os
import sys

# Import the daemon module without running its main (sage/jedi imports are
# guarded by try/except, so importing is safe even without sage).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'server'))
import sage_doc_daemon as d

passed = 0
failed = 0
skipped = 0

HAS_PREPARSE = d._sage_preparse is not None


def check(name, cond):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print('  FAIL - %s' % name)


def check_sage(name, cond):
    """Only assert when the sage preparser is available; otherwise skip."""
    global skipped
    if not HAS_PREPARSE:
        skipped += 1
        return
    check(name, cond)


print('== _preparse: fallback behavior (always runs) ==')
check('empty text', d._preparse('') == '')
check('none-ish text', d._preparse(None) == '')
if not HAS_PREPARSE:
    check('identity without sage', d._preparse('a = 2^3') == 'a = 2^3')

print('== _preparse: sage syntax -> valid python (sage only) ==')
import ast
check_sage('caret becomes **', '**' in d._preparse('a = 2^3'))
check_sage('generator syntax valid', ast.parse(d._preparse('R.<x> = PolynomialRing(QQ)')) is not None)
check_sage('range syntax valid', ast.parse(d._preparse('b = [1..10]')) is not None)
check_sage('function syntax valid', ast.parse(d._preparse('f(x) = x^2')) is not None)
check_sage('plain python untouched', d._preparse('import numpy as np') == 'import numpy as np')
check_sage('string content untouched', d._preparse("s = 'a^b <x>'") == "s = 'a^b <x>'")

mixed = 'R.<x> = PolynomialRing(QQ)\nimport numpy as np\na = 2^8\ns = """1^2\n<x>\n"""\nM = matrix(ZZ, 2, 2)'
check_sage('line count preserved', len(d._preparse(mixed).splitlines()) == len(mixed.splitlines()))

print('== _map_col: cursor column mapping (sage only) ==')
check_sage('no sage syntax -> identity', d._map_col('np.ar', 5) == 5)
check_sage('after literals expands', d._map_col('np.linspace(0, 1, 10)', 17) == len('np.linspace(Integer(0), Integer(1))'))
check_sage('after caret expands', d._map_col('a = 2^3 + np.ar', 15) == len('a = Integer(2)**Integer(3) + np.ar'))
check_sage('unbalanced prefix ok', d._map_col('np.linspace(0, ', 15) == len('np.linspace(Integer(0), '))
if not HAS_PREPARSE:
    check('no sage -> identity fallback', d._map_col('a = 2^3', 8) == 8)

print('== _mapped_jedi_position (sage only) ==')
jline, jcol = d._mapped_jedi_position('import numpy as np\nnp.linspace(0, 1)', 1, 12)
check_sage('jedi line = LSP line + 2', jline == 3)
check_sage('jedi col after "(" unchanged', jcol == 12)

print('== sync_namespace survives sage syntax (sage only) ==')
if HAS_PREPARSE and d.SAGE_AVAILABLE:
    r = d.sync_namespace('R.<x> = PolynomialRing(QQ)\nimport numpy as np\nM = matrix(ZZ, 2, 2)\n', enabled=True)
    check('synced with sage syntax', r.get('synced') is True)
    with d._NAMESPACE_LOCK:
        ns = dict(d._NAMESPACE)
    check('M in namespace', 'M' in ns)
    check('np in namespace', 'np' in ns)
    check('R in namespace (preparsed assign)', 'R' in ns)
    check('x in namespace (_first_ngens unpack)', 'x' in ns)
    check('R is a polynomial ring', 'PolynomialRing' in type(ns.get('R')).__name__ if 'R' in ns else False)
else:
    skipped += 6

print('\n%d passed, %d failed, %d skipped (sage%s available)' % (
    passed, failed, skipped, '' if HAS_PREPARSE else ' not'))
sys.exit(1 if failed else 0)
