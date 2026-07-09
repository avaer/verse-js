# Interfaces: implementation, dispatch through the interface type.
#>> circle: 12
#>> square: 9
shape := interface:
    Area() : int
circle := class(shape):
    Radius : int = 1
    Area<override>() : int = 3 * Radius * Radius
square := class(shape):
    Side : int = 1
    Area<override>() : int = Side * Side
Shapes : []shape = array{circle{Radius := 2}, square{Side := 3}}
for (S : Shapes):
    if (C := circle[S]):
        Print("circle: {C.Area()}")
    else if (Q := square[S]):
        Print("square: {Q.Area()}")
