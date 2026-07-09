// Failure-context rollback semantics (modelled on VerseVM's failure
// contexts + transactions): writes made inside a failing `if` condition or
// the left operand of `or` must be rolled back.
import { describe, expect, it } from 'vitest';
import { injectEnds } from '../src/verse/preprocess.js';
import { parse } from '../src/verse/parser.js';
import { VerseInterpreter } from '../src/verse/interpreter.js';

async function runInterpreterOnly(source) {
	const ast = parse(injectEnds(source));
	return await new VerseInterpreter().interpret(ast);
}

describe('failure-context rollback', () => {
	it('rolls back symbol writes made by a failing decides function in an if condition', async () => {
		const source = `
using { /Fortnite.com/Devices }
using { /UnrealEngine.com/Temporary/Diagnostics }

device := class(creative_device):

    OnBegin<override>()<suspends>:void=
        var Counter : int = 0
        if (TryBump[]):
            Print("succeeded")
        else:
            Print("failed")
        Print("Counter is {Counter}")

    TryBump()<decides>:void=
        set Counter += 10
        Mod[1, 0]
`;

		const expected = [
			'failed',
			'Counter is 0',
			'',
		].join('\n');

		expect(await runInterpreterOnly(source)).toBe(expected);
	});

	it('keeps writes when the failure context succeeds', async () => {
		// Array elements are shared by reference across method scopes, so a
		// successful decides call's element writes must persist.
		const source = `
using { /Fortnite.com/Devices }
using { /UnrealEngine.com/Temporary/Diagnostics }

device := class(creative_device):

    var Values : []int = array{100}

    OnBegin<override>()<suspends>:void=
        if (Bump[]):
            Print("succeeded")
        if (Value := Values[0]):
            Print("Value is {Value}")

    Bump()<decides>:void=
        set Values[0] = 110
        true
`;

		const expected = [
			'succeeded',
			'Value is 110',
			'',
		].join('\n');

		expect(await runInterpreterOnly(source)).toBe(expected);
	});

	it('rolls back array element writes on failure', async () => {
		const source = `
using { /Fortnite.com/Devices }
using { /UnrealEngine.com/Temporary/Diagnostics }

device := class(creative_device):

    var Values : []int = array{100}

    OnBegin<override>()<suspends>:void=
        if (Overdraw[]):
            Print("succeeded")
        else:
            Print("failed")
        if (Balance := Values[0]):
            Print("Balance is {Balance}")

    Overdraw()<decides>:void=
        set Values[0] = -900
        Mod[1, 0]
`;

		const expected = [
			'failed',
			'Balance is 100',
			'',
		].join('\n');

		expect(await runInterpreterOnly(source)).toBe(expected);
	});

	it('rolls back writes from the failing left operand of or', async () => {
		const source = `
using { /Fortnite.com/Devices }
using { /UnrealEngine.com/Temporary/Diagnostics }

device := class(creative_device):

    OnBegin<override>()<suspends>:void=
        var Counter : int = 0
        Result := BumpAndFail[] or 42
        Print("Result is {Result}")
        Print("Counter is {Counter}")

    BumpAndFail()<decides>:int=
        set Counter += 5
        Mod[1, 0]
`;

		const expected = [
			'Result is 42',
			'Counter is 0',
			'',
		].join('\n');

		expect(await runInterpreterOnly(source)).toBe(expected);
	});

	it('rolls back nested failure contexts without disturbing outer successful writes', async () => {
		const source = `
using { /Fortnite.com/Devices }
using { /UnrealEngine.com/Temporary/Diagnostics }

device := class(creative_device):

    var Outer : []int = array{0}
    var Inner : []int = array{0}

    OnBegin<override>()<suspends>:void=
        if (BumpOuter[]):
            if (BumpInnerAndFail[]):
                Print("inner succeeded")
            else:
                Print("inner failed")
        if (OuterValue := Outer[0]):
            Print("Outer is {OuterValue}")
        else:
            Print("Outer is 0")
        if (InnerValue := Inner[0]):
            Print("Inner is {InnerValue}")
        else:
            Print("Inner is 0")

    BumpOuter()<decides>:void=
        set Outer[0] = 1
        true

    BumpInnerAndFail()<decides>:void=
        set Inner[0] = 1
        Mod[1, 0]
`;

		const expected = [
			'inner failed',
			'Outer is 1',
			'Inner is 0',
			'',
		].join('\n');

		expect(await runInterpreterOnly(source)).toBe(expected);
	});
});
