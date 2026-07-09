# Speculative execution: writes inside a failed condition roll back.
#>> 1
#>> after: 1
var X : int = 1
if (set X = 99, X < 10, false?):
    Print("not printed")
Print("{X}")
if (X = 1):
    Print("after: {X}")
