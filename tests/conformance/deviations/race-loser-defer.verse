# Timing of a cancelled race loser's defer blocks.
#@@ deviation: Real Verse runs the loser's defers synchronously as part of
#@@ deviation: cancellation, before race returns. Our loser defers run on
#@@ deviation: the JS microtask queue, so they land after the winner's
#@@ deviation: continuation resumes.
#>> winner: fast
#>> slow cleaned up
#>> after sleep
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
Fast()<suspends> : string =
    Sleep(1.0)
    "fast"
Slow()<suspends> : string =
    defer:
        Print("slow cleaned up")
    Sleep(10.0)
    "slow"
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        W := race:
            Fast()
            Slow()
        Print("winner: {W}")
        Sleep(1.0)
        Print("after sleep")
