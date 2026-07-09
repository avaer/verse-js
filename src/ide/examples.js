// examples.js
// Default workspace files seeded on first launch.
// Kept in sync with the .verse files in /examples.

export const EXAMPLE_FILES = {
	'hello-world.verse': `using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }
using { /UnrealEngine.com/Temporary/Diagnostics }

# A Verse-authored creative device that can be placed in a level.
# Press Run (F5) to execute; every creative_device's OnBegin is the entry point.
hello_world_device := class(creative_device):

    # Runs when the device is started in a running game
    OnBegin<override>()<suspends> : void =
        Print("Hello, world!")
        Print("2 + 2 = {2 + 2}")
`,

	'failure-rollback.verse': `using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }
using { /UnrealEngine.com/Temporary/Diagnostics }

# Demonstrates Verse failure contexts and transactional rollback.
# A <decides> function fails instead of returning false, and when it fails,
# every write it made is rolled back (like VerseVM's speculative execution).
bank_device := class(creative_device):

    var Vault : []int = array{100}

    # Withdraws from the vault, but fails when it would overdraw.
    # The 'set' below is journaled: on failure it is undone.
    Withdraw(Amount : int)<decides> : logic =
        if (Balance := Vault[0]):
            set Vault[0] = Balance - Amount
        if (NewBalance := Vault[0]):
            NewBalance >= 0

    OnBegin<override>()<suspends> : void =
        if (Withdraw[30]):
            Print("Withdrew 30 gold")
        if (Withdraw[999]):
            Print("Withdrew 999 gold")
        else:
            Print("Withdrawal of 999 failed - the vault write was rolled back")
        if (Final := Vault[0]):
            Print("Final balance: {Final} gold")
`,

	'sleep-countdown.verse': `using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }
using { /UnrealEngine.com/Temporary/Diagnostics }

# Sleep is a <suspends> native: the async interpreter awaits it, so the
# countdown streams to the console in real time. Try pressing Stop mid-run.
countdown_device := class(creative_device):

    OnBegin<override>()<suspends> : void =
        Print("Countdown starting...")
        var Count : int = 3
        loop:
            if (Count <= 0):
                break
            Print("{Count}...")
            Sleep(1.0)
            set Count -= 1
        Print("Liftoff!")
`,

	'random-dice.verse': `using { /Fortnite.com/Devices }
using { /Verse.org/Random }
using { /UnrealEngine.com/Temporary/Diagnostics }

# Uses the /Verse.org/Random native module. Set a breakpoint on the Print
# inside the loop and press Debug to step through each roll.
dice_device := class(creative_device):

    OnBegin<override>()<suspends> : void =
        Print("Rolling 5 dice:")
        var Total : int = 0
        for (Roll := 1..5):
            Value := GetRandomInt(1, 6)
            Print("Roll {Roll}: {Value}")
            set Total += Value
        Print("Total: {Total}")
        if (Total > 20):
            Print("Lucky!")
        else:
            Print("Try again")
`,
};

export const DEFAULT_ACTIVE_FILE = 'hello-world.verse';
