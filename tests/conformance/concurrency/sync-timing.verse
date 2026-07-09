# sync waits for all clauses and returns a tuple of results.
#>> 1 2 at 3s
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
my_device := class(creative_device):
    Delayed(Seconds : float, Result : int)<suspends> : int =
        Sleep(Seconds)
        Result
    OnBegin<override>()<suspends> : void =
        Results := sync:
            Delayed(3.0, 1)
            Delayed(1.0, 2)
        Print("{Results(0)} {Results(1)} at {GetSimulationElapsedTime()}s")
