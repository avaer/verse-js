# Extension methods add members to existing types.
#>> 42
#>> hey!
#>> 3
(X : int).Doubled() : int = X + X
(S : string).Shout() : string = S + "!"
(A : []int).First()<decides> : int = A[0]
Print("{(21).Doubled()}")
Print(("hey").Shout())
Items := array{3, 9}
if (F := Items.First[]):
    Print("{F}")
