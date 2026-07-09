// prelude.ts
// The /Verse.org/Verse prelude: printing, math, and container helpers.
// Implicitly imported into every program.

import { defineModule, T } from '../bindings/registry';
import { VerseRuntimeError } from '../runtime/failure';
import {
	asRational, FAIL, Value, verseToDiagnostic, verseToString, VMap, VRational,
} from '../runtime/values';

const num = (v: Value): number => v as number;

function toFloat(v: Value): number {
	if (v instanceof VRational) {
		return v.toFloat();
	}
	return v as number;
}

export const preludeModule = defineModule(
	'/Verse.org/Verse',
	'The Verse prelude: printing, math, and container helpers. Always in scope.',
	(m) => {
		m.fn('Print', { params: [['Message', T.string]], ret: T.void },
			(args, ctx) => {
				ctx.shared.out('stdout', verseToString(args[0]));
				return undefined;
			},
			'Writes a message to the log/console.',
			'Print("Hello, world!")');

		m.fn('ToString', { params: [['Value', T.any]], ret: T.string },
			(args) => verseToString(args[0]),
			'Converts a value to its string representation.',
			'Print(ToString(42))');

		m.fn('ToDiagnostic', { params: [['Value', T.any]], ret: T.string },
			(args) => verseToDiagnostic(args[0]),
			'Converts any value to a diagnostic (debug) string.',
			'Print(ToDiagnostic(array{1, 2}))');

		m.fn('Abs', { params: [['X', T.int]], ret: T.int },
			(args) => {
				const v = args[0];
				if (v instanceof VRational) {
					return new VRational(Math.abs(v.num), v.den);
				}
				return Math.abs(num(v));
			},
			'Absolute value.', 'Abs(-5) = 5');
		m.overload('Abs', { params: [['X', T.float]], ret: T.float });
		m.overload('Abs', { params: [['X', T.rational]], ret: T.rational });

		m.fn('Floor', { params: [['X', T.float]], ret: T.int },
			(args) => {
				const v = args[0];
				return v instanceof VRational ? v.floor() : Math.floor(num(v));
			},
			'Rounds down to the nearest integer.', 'Floor(2.7) = 2');
		m.overload('Floor', { params: [['X', T.rational]], ret: T.int });

		m.fn('Ceil', { params: [['X', T.float]], ret: T.int },
			(args) => {
				const v = args[0];
				return v instanceof VRational ? v.ceil() : Math.ceil(num(v));
			},
			'Rounds up to the nearest integer.', 'Ceil(2.1) = 3');
		m.overload('Ceil', { params: [['X', T.rational]], ret: T.int });

		m.fn('Round', { params: [['X', T.float]], ret: T.int },
			(args) => {
				const v = args[0];
				return v instanceof VRational ? Math.round(v.toFloat()) : Math.round(num(v));
			},
			'Rounds to the nearest integer.', 'Round(2.5) = 3');
		m.overload('Round', { params: [['X', T.rational]], ret: T.int });

		m.fn('Int', { params: [['X', T.float]], ret: T.int, effects: { decides: true } },
			(args) => {
				const v = toFloat(args[0]);
				return Number.isInteger(v) ? v : FAIL;
			},
			'Failable conversion to int; succeeds only when the value is integral.',
			'if (N := Int[4.0]) { Print("{N}") }');
		m.overload('Int', { params: [['X', T.rational]], ret: T.int, effects: { decides: true } });

		m.fn('ToFloat', { params: [['X', T.int]], ret: T.float },
			(args) => toFloat(args[0]),
			'Converts an int or rational to float.', 'ToFloat(3) = 3.0');
		m.overload('ToFloat', { params: [['X', T.rational]], ret: T.float });

		m.fn('Sqrt', { params: [['X', T.float]], ret: T.float },
			(args) => Math.sqrt(num(args[0])),
			'Square root.', 'Sqrt(9.0) = 3.0');

		m.fn('Pow', { params: [['Base', T.float], ['Exponent', T.float]], ret: T.float },
			(args) => Math.pow(num(args[0]), num(args[1])),
			'Raises Base to Exponent.', 'Pow(2.0, 10.0) = 1024.0');

		m.fn('Exp', { params: [['X', T.float]], ret: T.float },
			(args) => Math.exp(num(args[0])), 'e raised to X.');
		m.fn('Ln', { params: [['X', T.float]], ret: T.float, effects: { decides: true } },
			(args) => (num(args[0]) > 0 ? Math.log(num(args[0])) : FAIL),
			'Natural logarithm; fails for non-positive values.', 'if (L := Ln[2.718]) {}');
		m.fn('Sin', { params: [['Radians', T.float]], ret: T.float }, (args) => Math.sin(num(args[0])), 'Sine of an angle in radians.');
		m.fn('Cos', { params: [['Radians', T.float]], ret: T.float }, (args) => Math.cos(num(args[0])), 'Cosine of an angle in radians.');
		m.fn('Tan', { params: [['Radians', T.float]], ret: T.float }, (args) => Math.tan(num(args[0])), 'Tangent of an angle in radians.');
		m.fn('ArcTan', { params: [['Y', T.float], ['X', T.float]], ret: T.float }, (args) => Math.atan2(num(args[0]), num(args[1])), 'Two-argument arctangent.');

		m.fn('Min', { params: [['A', T.int], ['B', T.int]], ret: T.int },
			(args) => {
				const [a, b] = args;
				if (a instanceof VRational || b instanceof VRational) {
					return asRational(a).compare(asRational(b)) <= 0 ? a : b;
				}
				return Math.min(num(a), num(b));
			},
			'The smaller of two values.', 'Min(3, 7) = 3');
		m.overload('Min', { params: [['A', T.float], ['B', T.float]], ret: T.float });

		m.fn('Max', { params: [['A', T.int], ['B', T.int]], ret: T.int },
			(args) => {
				const [a, b] = args;
				if (a instanceof VRational || b instanceof VRational) {
					return asRational(a).compare(asRational(b)) >= 0 ? a : b;
				}
				return Math.max(num(a), num(b));
			},
			'The larger of two values.', 'Max(3, 7) = 7');
		m.overload('Max', { params: [['A', T.float], ['B', T.float]], ret: T.float });

		m.fn('Clamp', { params: [['X', T.int], ['Low', T.int], ['High', T.int]], ret: T.int },
			(args) => Math.min(Math.max(num(args[0]), num(args[1])), num(args[2])),
			'Clamps X into [Low, High].', 'Clamp(12, 0, 10) = 10');
		m.overload('Clamp', { params: [['X', T.float], ['Low', T.float], ['High', T.float]], ret: T.float });

		m.fn('Mod', { params: [['X', T.int], ['Y', T.int]], ret: T.int, effects: { decides: true } },
			(args) => {
				const y = num(args[1]);
				if (y === 0) {
					return FAIL;
				}
				return num(args[0]) % y;
			},
			'Remainder of X / Y; fails when Y = 0.', 'if (R := Mod[7, 3]) { Print("{R}") }');

		m.fn('Quotient', { params: [['X', T.int], ['Y', T.int]], ret: T.int, effects: { decides: true } },
			(args) => {
				const y = num(args[1]);
				if (y === 0) {
					return FAIL;
				}
				return Math.trunc(num(args[0]) / y);
			},
			'Integer division of X by Y, truncated toward zero; fails when Y = 0.',
			'if (Q := Quotient[7, 2]) { Print("{Q}") }');

		m.fn('Concatenate', { params: [['Left', T.array(T.any)], ['Right', T.array(T.any)]], ret: T.array(T.any) },
			(args) => {
				const a = args[0];
				const b = args[1];
				if (typeof a === 'string' && typeof b === 'string') {
					return a + b;
				}
				return ([] as Value[]).concat(a as Value[], b as Value[]);
			},
			'Concatenates two arrays (or strings).', 'Concatenate(array{1}, array{2}) = array{1, 2}');
		m.overload('Concatenate', { params: [['Left', T.string], ['Right', T.string]], ret: T.string });

		m.fn('ConcatenateMaps', { params: [['Left', T.map(T.comparable, T.any)], ['Right', T.map(T.comparable, T.any)]], ret: T.map(T.comparable, T.any) },
			(args) => {
				const left = args[0] as VMap;
				const right = args[1] as VMap;
				const result = left.clone();
				for (const [key, value] of right.pairs()) {
					result.set(key, value);
				}
				return result;
			},
			'Merges two maps; entries in Right win on key collisions.',
			'ConcatenateMaps(map{1 => "a"}, map{2 => "b"})');

		m.fn('Length', { params: [['Text', T.string]], ret: T.int },
			(args) => {
				const v = args[0];
				if (typeof v === 'string') {
					return v.length;
				}
				if (Array.isArray(v)) {
					return v.length;
				}
				if (v instanceof VMap) {
					return v.size;
				}
				return 0;
			},
			'Length of a string or array (also available as .Length).');

		m.fn('ToUpper', { params: [['Text', T.string]], ret: T.string },
			(args) => (args[0] as string).toUpperCase(),
			'Uppercases a string.', 'ToUpper("verse") = "VERSE"');

		m.fn('ToLower', { params: [['Text', T.string]], ret: T.string },
			(args) => (args[0] as string).toLowerCase(),
			'Lowercases a string.', 'ToLower("VERSE") = "verse"');

		m.fn('Contains', { params: [['Text', T.string], ['Substring', T.string]], ret: T.void, effects: { decides: true } },
			(args) => ((args[0] as string).includes(args[1] as string) ? undefined : FAIL),
			'Succeeds when Text contains Substring.', 'if (Contains["hello", "ell"]) {}');

		m.fn('Split', { params: [['Text', T.string], ['Separator', T.string]], ret: T.array(T.string) },
			(args) => (args[0] as string).split(args[1] as string),
			'Splits Text on every occurrence of Separator.',
			'Split("a,b,c", ",") = array{"a", "b", "c"}');

		m.fn('Join', { params: [['Parts', T.array(T.string)], ['Separator', T.string]], ret: T.string },
			(args) => (args[0] as Value[]).map((p) => verseToString(p)).join(args[1] as string),
			'Joins an array of strings with a separator.',
			'Join(array{"a", "b"}, "-") = "a-b"');

		m.fn('Reverse', { params: [['Items', T.array(T.any)]], ret: T.array(T.any) },
			(args) => {
				const v = args[0];
				if (typeof v === 'string') {
					return [...v].reverse().join('');
				}
				return [...(v as Value[])].reverse();
			},
			'A new array (or string) with the elements in reverse order.',
			'Reverse(array{1, 2, 3}) = array{3, 2, 1}');
		m.overload('Reverse', { params: [['Text', T.string]], ret: T.string });

		m.fn('Keys', { params: [['Map', T.map(T.comparable, T.any)]], ret: T.array(T.comparable) },
			(args) => [...(args[0] as VMap).pairs()].map(([k]) => k),
			'The keys of a map, in insertion order.', 'Keys(map{1 => "a"}) = array{1}');

		m.fn('Values', { params: [['Map', T.map(T.comparable, T.any)]], ret: T.array(T.any) },
			(args) => [...(args[0] as VMap).pairs()].map(([, v]) => v),
			'The values of a map, in insertion order.', 'Values(map{1 => "a"}) = array{"a"}');
	},
	{ implicit: true },
);

/** @internal Shared by other stdlib modules; exported for reuse. */
export const helpers = { num, toFloat, intCheck };

function intCheck(v: number, what: string): number {
	if (!Number.isFinite(v)) {
		throw new VerseRuntimeError(`${what} produced a non-finite int`);
	}
	return v;
}
