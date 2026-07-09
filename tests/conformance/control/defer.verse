# defer runs when the enclosing block exits, in reverse order of
# registration, even on early return.
#>> body
#>> second
#>> first
#>> after
Go() : void =
    defer:
        Print("first")
    defer:
        Print("second")
    Print("body")
Go()
Print("after")
