// colors.ts
// /Verse.org/Colors: named colors as hex strings plus helpers to build
// them. In UEFN these are color values; here they are handy for console
// demos.

import { defineModule, T } from '../bindings/registry';
import { FAIL } from '../runtime/values';

export const colorsModule = defineModule(
	'/Verse.org/Colors',
	'Named colors as hex strings, plus helpers to build them. In UEFN these are color values; here they are handy for console demos.',
	(m) => {
		m.fn('MakeColorFromHex', { params: [['Hex', T.string]], ret: T.string, effects: { decides: true } },
			(args) => {
				const hex = args[0] as string;
				return /^#?[0-9A-Fa-f]{6}$/.test(hex) ? (hex.startsWith('#') ? hex : `#${hex}`) : FAIL;
			},
			'Validates and normalizes a #RRGGBB hex color string.',
			'if (C := MakeColorFromHex["FF8800"]) { Print(C) }');
		const named: [string, string][] = [
			['White', '#FFFFFF'], ['Black', '#000000'], ['Red', '#FF0000'],
			['Green', '#00FF00'], ['Blue', '#0000FF'], ['Yellow', '#FFFF00'],
			['Cyan', '#00FFFF'], ['Magenta', '#FF00FF'], ['Orange', '#FF8800'],
			['Purple', '#8800FF'],
		];
		for (const [name, hex] of named) {
			m.value(name, T.string, hex, `The color ${name.toLowerCase()} (${hex}).`);
		}
	},
);
