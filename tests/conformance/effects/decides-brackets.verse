# A <decides> function must be invoked with [] brackets, not ().
#!! 7: call it with '[...]' instead of '(...)'
Half(X : int)<decides> : int =
    Mod[X, 2] = 0
    X
Broken() : void =
    Half(4)
