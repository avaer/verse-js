using { /Fortnite.com/Devices }
using { /Verse.org/Random }
using { /UnrealEngine.com/Temporary/Diagnostics }

# Uses the /Verse.org/Random native module. Set a breakpoint on the Print
# inside the loop and press Debug to step through each roll.
dice_device := class(creative_device):

    OnBegin<override>()<suspends> : void =
        Print("Rolling 5 dice:")
        var Total : int = 0
        for (Roll := 1..5):
            Value := GetRandomInt(1, 6)
            Print("Roll {Roll}: {Value}")
            set Total += Value
        Print("Total: {Total}")
        if (Total > 20):
            Print("Lucky!")
        else:
            Print("Try again")
