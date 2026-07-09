# Parametric functions and classes with where clauses.
#>> 42
#>> hello
#>> 9
#>> first
Identity(X : t where t : type) : t = X
Print("{Identity(42)}")
Print(Identity("hello"))
box(t : type) := class:
    Value : t
B := box(int){Value := 9}
Print("{B.Value}")
FirstOf(Items : []t, Fallback : t where t : type) : t =
    if (F := Items[0]) then F else Fallback
Print(FirstOf(array{"first", "second"}, "none"))
