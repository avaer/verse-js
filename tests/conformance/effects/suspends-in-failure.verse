# Suspending calls cannot appear inside a failure context.
#!! 8: Suspending calls are not allowed inside a failure context
using { /Verse.org/Simulation }
Napper()<suspends> : logic =
    Sleep(1.0)
    true
Check()<suspends> : void =
    if (Napper() = true):
        Print("no")
