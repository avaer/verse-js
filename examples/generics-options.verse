# Parametric functions (where clauses), option types, and extension methods.

# A generic function: works for any type t.
FirstOr(Items : []t, Fallback : t where t : type) : t =
    if (First := Items[0]) then First else Fallback

# Extension methods add members to existing types.
(X : int).Squared() : int = X * X
(S : string).Shout() : string = S + "!"

Names : []string = array{"alice", "bob"}
Empty : []int = array{}

Print(FirstOr(Names, "nobody"))
Print("{FirstOr(Empty, -1)}")

MaybeScore : ?int = option{7}
if (Score := MaybeScore?):
    Print("score is {Score.Squared()}")

NoScore : ?int = false
Message := if (S := NoScore?) then "{S}" else "no score yet"
Print(Message.Shout())
