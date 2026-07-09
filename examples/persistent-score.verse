using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }
using { /Verse.org/Random }

# Module-scoped weak_map vars persist between runs (localStorage in this
# IDE, durable player storage in UEFN). Run this a few times!

var HighScore : weak_map(player, int) = map{}

score_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        ThePlayer := GetLocalPlayer()
        var Best : int = 0
        if (Existing := HighScore[ThePlayer]):
            set Best = Existing
        Roll := GetRandomInt(1, 100)
        Print("you rolled {Roll} (best so far: {Best})")
        if (Roll > Best):
            Print("new high score!")
            if (set HighScore[ThePlayer] = Roll) {}
