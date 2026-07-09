# Structs have value semantics: assignment copies.
#>> 1 1
#>> p2: 5
#>> p1: 1
point := struct:
    var X : int = 0
P1 := point{X := 1}
P2 := P1
Print("{P1.X} {P2.X}")
var P3 : point = P1
if (set P3.X = 5) {}
Print("p2: {P3.X}")
Print("p1: {P1.X}")
