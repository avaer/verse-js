# Calling a <suspends> function from a non-suspending function is an error.
#!! 7: the caller must be marked '<suspends>'
using { /Verse.org/Simulation }
Napper()<suspends> : void =
    Sleep(1.0)
Plain() : void =
    Napper()
