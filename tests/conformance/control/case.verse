# case expressions with literal clauses and a wildcard default.
#>> one
#>> many
#>> wild
Describe(N : int) : string =
    case (N):
        1 => "one"
        2 => "two"
        _ => "many"
Print(Describe(1))
Print(Describe(5))
W := case ("z"):
    "a" => "first"
    _ => "wild"
Print(W)
