# spawn creates a task; Await joins it. Sleep uses the virtual clock.
#>> worker at 1s
#>> joined: 7 at 1s
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
Worker()<suspends> : int =
    Sleep(1.0)
    Print("worker at {GetSimulationElapsedTime()}s")
    7
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        T := spawn{ Worker() }
        R := T.Await()
        Print("joined: {R} at {GetSimulationElapsedTime()}s")
