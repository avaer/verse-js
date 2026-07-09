// random.ts
// /Verse.org/Random: pseudo-random number generation, driven by the host's
// pluggable rng (RunOptions.rng) for deterministic testing.

import { defineModule, T } from '../bindings/registry';
import { Value } from '../runtime/values';
import { helpers } from './prelude';

const { num, intCheck } = helpers;

export const randomModule = defineModule(
	'/Verse.org/Random',
	'Pseudo-random number generation.',
	(m) => {
		m.fn('GetRandomInt', { params: [['Min', T.int], ['Max', T.int]], ret: T.int },
			(args, ctx) => {
				const min = Math.ceil(num(args[0]));
				const max = Math.floor(num(args[1]));
				return intCheck(min + Math.floor(ctx.shared.rng() * (max - min + 1)), 'GetRandomInt');
			},
			'A uniformly random int in [Min, Max] (inclusive).',
			'Roll := GetRandomInt(1, 6)');

		m.fn('GetRandomFloat', { params: [['Min', T.float], ['Max', T.float]], ret: T.float },
			(args, ctx) => num(args[0]) + ctx.shared.rng() * (num(args[1]) - num(args[0])),
			'A uniformly random float in [Min, Max).',
			'X := GetRandomFloat(0.0, 1.0)');

		m.fn('Shuffle', { params: [['Items', T.array(T.any)]], ret: T.array(T.any) },
			(args, ctx) => {
				const result = [...(args[0] as Value[])];
				for (let i = result.length - 1; i > 0; i--) {
					const j = Math.floor(ctx.shared.rng() * (i + 1));
					[result[i], result[j]] = [result[j], result[i]];
				}
				return result;
			},
			'A new array with the elements in random order.',
			'Shuffled := Shuffle(array{1, 2, 3})');
	},
);
