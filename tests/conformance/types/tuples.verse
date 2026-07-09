# Tuples: construction, element access by index call syntax.
#>> 1 two
#>> 5
Pair := (1, "two")
Print("{Pair(0)} {Pair(1)}")
Swap(T : tuple(int, int)) : tuple(int, int) = (T(1), T(0))
S := Swap((3, 5))
Print("{S(0)}")
