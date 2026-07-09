# race returns the first clause to finish and cancels the rest.
#>> winner: fast
#>> time: 1s
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
Fast()<suspends> : string =
    Sleep(1.0)
    "fast"
Slow()<suspends> : string =
    Sleep(10.0)
    Print("slow ran (wrong)")
    "slow"
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        W := race:
            Fast()
            Slow()
        Print("winner: {W}")
        Print("time: {GetSimulationElapsedTime()}s")
