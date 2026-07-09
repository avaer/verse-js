# Classes, interfaces-style overrides, enums, and dynamic casts.
# Every shape is stored as the base class; X[S] casts back down.

shape := class:
    Area() : int = 0

circle := class(shape):
    Radius : int = 1
    Area<override>() : int = 3 * Radius * Radius

square := class(shape):
    Side : int = 1
    Area<override>() : int = Side * Side

color := enum:
    Red
    Green
    Blue

NameOf(C : color) : string =
    case (C):
        color.Red => "red"
        color.Green => "green"
        _ => "blue"

Shapes : []shape = array{circle{Radius := 2}, square{Side := 3}}
for (S : Shapes):
    if (C := circle[S]):
        Print("circle with area {C.Area()}")
    else if (Q := square[S]):
        Print("square with area {Q.Area()}")

Print("favorite color: {NameOf(color.Green)}")
