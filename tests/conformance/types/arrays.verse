# Arrays: literals, failable indexing, Length, slices, concatenation.
#>> 3
#>> 10
#>> out of range
#>> 5
#>> 20 30
A := array{10, 20, 30}
Print("{A.Length}")
if (First := A[0]):
    Print("{First}")
if (A[9]):
    Print("not printed")
else:
    Print("out of range")
B := A + array{40, 50}
Print("{B.Length}")
if (S := A.Slice[1, 3], X := S[0], Y := S[1]):
    Print("{X} {Y}")
