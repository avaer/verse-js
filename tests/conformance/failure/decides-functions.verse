# <decides> functions fail instead of returning; called with [] brackets.
#>> 4
#>> odd
Half(X : int)<decides> : int =
    Mod[X, 2] = 0
    X / 2
    Quotient[X, 2]
if (H := Half[8]):
    Print("{H}")
if (Half[7]):
    Print("even")
else:
    Print("odd")
