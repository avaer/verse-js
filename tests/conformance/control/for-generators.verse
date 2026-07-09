# for over ranges and arrays, with filters and multiple generators; a for
# expression produces an array of its body results.
#>> 6
#>> evens: 2
#>> pairs: 4
#>> 9 16
var Sum : int = 0
for (I := 1..3):
    set Sum += I
Print("{Sum}")
Evens := for (I := 1..5, Mod[I, 2] = 0) { I }
Print("evens: {Evens.Length}")
var Count : int = 0
for (A := 1..2, B := 1..2):
    set Count += 1
Print("pairs: {Count}")
Squares := for (X : array{3, 4}) { X * X }
var Text : string = ""
for (S : Squares):
    set Text += "{S} "
if (Trimmed := Squares[0], Last := Squares[1]):
    Print("{Trimmed} {Last}")
