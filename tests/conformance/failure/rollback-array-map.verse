# Rollback covers array elements and map entries, not just plain vars.
#>> arr: 1
#>> map: 10
var Arr : []int = array{1, 2, 3}
var M : [string]int = map{"a" => 10}
FailAfterWrites()<decides> : void =
    set Arr[0] = 99
    set M["a"] = 99
    false?
if (FailAfterWrites[]):
    Print("not printed")
if (A := Arr[0]):
    Print("arr: {A}")
if (V := M["a"]):
    Print("map: {V}")
