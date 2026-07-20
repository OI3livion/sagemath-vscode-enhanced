import * as assert from 'assert';
import { getCallContextFromText } from '../../server/src/signatureHelp.js';

suite('getCallContextFromText', () => {
	test('finds callee and argument index', () => {
		assert.deepStrictEqual(getCallContextFromText('plot(sin(x), '), { callee: 'plot', argIndex: 1 });
	});

	test('argument index is 0 right after the opening paren', () => {
		assert.deepStrictEqual(getCallContextFromText('matrix('), { callee: 'matrix', argIndex: 0 });
	});

	test('counts only top-level commas across nested calls', () => {
		assert.deepStrictEqual(getCallContextFromText('foo(a, bar(1,2), '), { callee: 'foo', argIndex: 2 });
	});

	test('returns undefined when not inside a call', () => {
		assert.strictEqual(getCallContextFromText('x = 5'), undefined);
	});

	test('ignores commas inside string literals', () => {
		assert.deepStrictEqual(getCallContextFromText('f("a,b,c", '), { callee: 'f', argIndex: 1 });
	});

	test('ignores commas inside line comments', () => {
		assert.deepStrictEqual(getCallContextFromText('f(a, # a, b,\n '), { callee: 'f', argIndex: 1 });
	});

	test('returns undefined for indexing with [', () => {
		assert.strictEqual(getCallContextFromText('lst[0] + '), undefined);
	});

	test('supports dotted callee names', () => {
		assert.deepStrictEqual(getCallContextFromText('M.det('), { callee: 'M.det', argIndex: 0 });
	});
});
