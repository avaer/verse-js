# event: Await blocks until Signal; the payload is delivered to waiters.
#>> waiting
#>> got 42 at 2s
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
my_device := class(creative_device):
    Ready : event(int) = event(int){}
    Waiter()<suspends> : void =
        Print("waiting")
        V := Ready.Await()
        Print("got {V} at {GetSimulationElapsedTime()}s")
    OnBegin<override>()<suspends> : void =
        T := spawn{ Waiter() }
        Sleep(2.0)
        Ready.Signal(42)
        T.Await()
