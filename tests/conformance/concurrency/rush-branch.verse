# rush returns the first result but lets losers finish; branch work is
# cancelled when the enclosing function exits.
#>> first: quick
#>> slow still finished
#>> tick
#>> work done
#>> after
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
my_device := class(creative_device):
    Quick()<suspends> : string =
        Sleep(1.0)
        "quick"
    Slow()<suspends> : string =
        Sleep(2.0)
        Print("slow still finished")
        "slow"
    Background()<suspends> : void =
        loop:
            Sleep(1.0)
            Print("tick")
    Work()<suspends> : void =
        branch:
            Background()
        Sleep(1.5)
        Print("work done")
    OnBegin<override>()<suspends> : void =
        First := rush:
            Quick()
            Slow()
        Print("first: {First}")
        Sleep(5.0)
        Work()
        Sleep(3.0)
        Print("after")
