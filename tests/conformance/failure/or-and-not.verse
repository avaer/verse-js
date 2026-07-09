# or/and/not in failure contexts. The left operand of `or` is speculative.
#>> fallback
#>> 3
#>> not-failed
var X : int = 3
Bad()<decides> : int =
    set X = 99
    false?
    0
Value := if (V := Bad[] or 7) then V else 0
if (Value = 7):
    Print("fallback")
Print("{X}")
if (not (X > 10)):
    Print("not-failed")
