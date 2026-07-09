# Cancel() stops a task; its defer blocks still run.
#>> tick
#>> cleaned up
#>> end at 4.5s
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
Ticker()<suspends> : void =
    defer:
        Print("cleaned up")
    loop:
        Sleep(1.0)
        Print("tick")
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        T := spawn{ Ticker() }
        Sleep(1.5)
        T.Cancel()
        Sleep(3.0)
        Print("end at {GetSimulationElapsedTime()}s")
