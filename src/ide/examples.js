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
    Withdraw(Amount : int)<decides> : void =
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

	'shapes-classes.verse': `# Classes, interfaces-style overrides, enums, and dynamic casts.
# Every shape is stored as the base class; X[S] casts back down.

shape := class:
    Area() : int = 0

circle := class(shape):
    Radius : int = 1
    Area<override>() : int = 3 * Radius * Radius

square := class(shape):
    Side : int = 1
    Area<override>() : int = Side * Side

color := enum:
    Red
    Green
    Blue

NameOf(C : color) : string =
    case (C):
        color.Red => "red"
        color.Green => "green"
        _ => "blue"

Shapes : []shape = array{circle{Radius := 2}, square{Side := 3}}
for (S : Shapes):
    if (C := circle[S]):
        Print("circle with area {C.Area()}")
    else if (Q := square[S]):
        Print("square with area {Q.Area()}")

Print("favorite color: {NameOf(color.Green)}")
`,

	'race-and-sync.verse': `using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }

# Structured concurrency: race cancels the loser (running its defer),
# sync waits for every clause, spawn returns an awaitable task.

Fetch(Name : string, Seconds : float)<suspends> : string =
    defer:
        Print("{Name} cleaned up")
    Sleep(Seconds)
    Print("{Name} finished at {GetSimulationElapsedTime()}s")
    Name

concurrency_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        Winner := race:
            Fetch("cache", 1.0)
            Fetch("network", 5.0)
        Print("race winner: {Winner}")

        Results := sync:
            Fetch("left", 1.0)
            Fetch("right", 2.0)
        Print("sync got {Results(0)} and {Results(1)} at {GetSimulationElapsedTime()}s")
`,

	'generics-options.verse': `# Parametric functions (where clauses), option types, and extension methods.

# A generic function: works for any type t.
FirstOr(Items : []t, Fallback : t where t : type) : t =
    if (First := Items[0]) then First else Fallback

# Extension methods add members to existing types.
(X : int).Squared() : int = X * X
(S : string).Shout() : string = S + "!"

Names : []string = array{"alice", "bob"}
Empty : []int = array{}

Print(FirstOr(Names, "nobody"))
Print("{FirstOr(Empty, -1)}")

MaybeScore : ?int = option{7}
if (Score := MaybeScore?):
    Print("score is {Score.Squared()}")

NoScore : ?int = false
Message := if (S := NoScore?) then "{S}" else "no score yet"
Print(Message.Shout())
`,

	'math-lib.verse': `# Shared helpers for multi-file-demo.verse. The IDE compiles every file
# in the workspace together (one shared module scope), so other files can
# call these directly — no import needed for same-workspace definitions.

GoldenRatio : float = 1.618034

Average(A : float, B : float) : float = (A + B) / 2.0

Lerp(A : float, B : float, T : float) : float = A + (B - A) * T
`,

	'multi-file-demo.verse': `# Multi-file workspaces: this file calls functions defined in
# math-lib.verse. Press Run with this file active — it becomes the entry
# point and the rest of the workspace acts as a library. Try Ctrl+Click
# on the call below to jump to the defining file.

Avg := Average(3.0, 5.0)
Mid := Lerp(0.0, 10.0, 0.25)

Print("Average(3.0, 5.0) = {Avg}")
Print("Lerp(0.0, 10.0, 0.25) = {Mid}")
Print("GoldenRatio = {GoldenRatio}")
`,

	'persistent-score.verse': `using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }
using { /Verse.org/Random }

# Module-scoped weak_map vars persist between runs (localStorage in this
# IDE, durable player storage in UEFN). Run this a few times!

var HighScore : weak_map(player, int) = map{}

score_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        ThePlayer := GetLocalPlayer()
        var Best : int = 0
        if (Existing := HighScore[ThePlayer]):
            set Best = Existing
        Roll := GetRandomInt(1, 100)
        Print("you rolled {Roll} (best so far: {Best})")
        if (Roll > Best):
            Print("new high score!")
            if (set HighScore[ThePlayer] = Roll) {}
`,
};

export const DEFAULT_ACTIVE_FILE = 'hello-world.verse';
