using { /Fortnite.com/Devices }
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
