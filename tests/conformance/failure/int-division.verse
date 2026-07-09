# Integer division is failable (division by zero) and produces a rational.
#>> 3
#>> 7/2
#>> div-by-zero failed
if (Q := 6 / 2):
    Print("{Q}")
if (R := 7 / 2):
    Print("{R}")
Zero := 0
if (7 / Zero):
    Print("not printed")
else:
    Print("div-by-zero failed")
