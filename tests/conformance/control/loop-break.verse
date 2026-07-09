# loop with break, and a counting pattern.
#>> 0
#>> 1
#>> 2
#>> done
var I : int = 0
loop:
    if (I >= 3):
        break
    Print("{I}")
    set I += 1
Print("done")
