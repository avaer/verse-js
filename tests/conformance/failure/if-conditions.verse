# Failure contexts: if with multiple comma-separated conditions, all must
# succeed; comparisons return their left operand on success.
#>> both hold
#>> 5
#>> else branch
X := 5
Y := 10
if (X < Y, Y = 10):
    Print("both hold")
if (Z := X, Z > 0):
    Print("{Z}")
if (X > Y):
    Print("not printed")
else:
    Print("else branch")
