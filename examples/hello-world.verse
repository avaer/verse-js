using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }
using { /UnrealEngine.com/Temporary/Diagnostics }

# A Verse-authored creative device that can be placed in a level.
# Press Run (F5) to execute; every creative_device's OnBegin is the entry point.
hello_world_device := class(creative_device):

    # Runs when the device is started in a running game
    OnBegin<override>()<suspends> : void =
        Print("Hello, world!")
        Print("2 + 2 = {2 + 2}")
