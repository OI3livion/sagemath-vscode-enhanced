#!/usr/bin/env python3
"""Unit tests for the namespace AST safety validator.

Tests _rhs_is_safe and _statement_is_eligible from sage_doc_daemon.py.
Runs with plain python3 -- no sage or jedi needed. Exercises the security
boundary that prevents arbitrary code execution via the namespace feature.
"""
import ast
import sys
import os

# Import the daemon module without running its main (sage/jedi imports are
# guarded by try/except, so importing is safe even without sage).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'server'))
import sage_doc_daemon as d

passed = 0
failed = 0


def check(name, cond):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print('  FAIL - %s' % name)


def rhs_safe(src):
    """Parse `src` as an expression and check _rhs_is_safe."""
    return d._rhs_is_safe(ast.parse(src, mode='eval').body)


def stmt_eligible(src):
    """Parse `src` as a statement and return its eligibility kind."""
    tree = ast.parse(src)
    if not tree.body:
        return None
    kind, _ = d._statement_is_eligible(tree.body[0])
    return kind


print('== _rhs_is_safe: allowed constructs ==')
check('literal int', rhs_safe('42'))
check('literal string', rhs_safe('"hello"'))
check('name reference', rhs_safe('x'))
check('simple call', rhs_safe('matrix([[1,2],[3,4]])'))
check('call with kwargs', rhs_safe('plot(f, (x, 0, 1), color="red")'))
check('dotted call', rhs_safe('PolynomialRing(QQ, "x")'))
check('binop', rhs_safe('x + 1'))
check('unaryop', rhs_safe('-x'))
check('tuple literal', rhs_safe('(1, 2, 3)'))
check('list literal', rhs_safe('[1, 2, 3]'))
check('dict literal', rhs_safe('{"a": 1}'))
check('subscript on name', rhs_safe('lst[0]'))

print('== _rhs_is_safe: rejected constructs ==')
check('eval() call', not rhs_safe('eval("1+1")'))
check('exec() call', not rhs_safe('exec("x=1")'))
check('__import__() call', not rhs_safe('__import__("os")'))
check('globals() call', not rhs_safe('globals()'))
check('getattr() call', not rhs_safe('getattr(obj, "x")'))
check('dunder attribute', not rhs_safe('obj.__class__'))
check('dunder method call', not rhs_safe('obj.__init__()'))
check('list comprehension', not rhs_safe('[x for x in y]'))
check('dict comprehension', not rhs_safe('{k: v for k, v in d}'))
check('set comprehension', not rhs_safe('{x for x in y}'))
check('generator expression', not rhs_safe('(x for x in y)'))
check('lambda', not rhs_safe('lambda x: x'))
check('starred in tuple', not rhs_safe('(*args,)'))
check('walrus operator', not rhs_safe('(x := 1)'))
check('slice subscript', not rhs_safe('lst[1:3]'))
check('attribute call to dunder', not rhs_safe('foo.__bar__()'))

print('== _statement_is_eligible: statement kinds ==')
check('simple assignment', stmt_eligible('M = matrix([[1,2]])') == 'assign')
check('annotated assignment', stmt_eligible('x: int = 5') == 'assign')
check('import statement', stmt_eligible('import numpy as np') == 'import')
check('from import', stmt_eligible('from sage.all import *') == 'import')
check('rejected: attribute assignment', stmt_eligible('obj.x = 5') is None)
check('rejected: subscript assignment', stmt_eligible('lst[0] = 5') is None)
check('rejected: function def', stmt_eligible('def f(): pass') is None)
check('rejected: class def', stmt_eligible('class C: pass') is None)
check('rejected: for loop', stmt_eligible('for x in y: pass') is None)
check('rejected: if statement', stmt_eligible('if True: pass') is None)
check('rejected: with statement', stmt_eligible('with open("f"): pass') is None)
check('rejected: del statement', stmt_eligible('del x') is None)
check('rejected: assignment with eval()', stmt_eligible('x = eval("1")') is None)
check('rejected: assignment with comprehension', stmt_eligible('x = [i for i in range(3)]') is None)

print('\n%d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)
