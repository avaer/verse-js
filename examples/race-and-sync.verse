using { /Fortnite.com/Devices }
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
