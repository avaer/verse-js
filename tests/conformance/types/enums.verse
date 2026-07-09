# Enums: values, equality as failure, case dispatch.
#>> up
#>> sideways
#>> matched east
direction := enum:
    North
    East
    South
    West
Describe(D : direction) : string =
    case (D):
        direction.North => "up"
        direction.South => "down"
        _ => "sideways"
Print(Describe(direction.North))
Print(Describe(direction.West))
E := direction.East
if (E = direction.East):
    Print("matched east")
