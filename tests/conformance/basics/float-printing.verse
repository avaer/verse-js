# Float-to-string formatting: integral floats keep a trailing ".0", like
# real Verse. Formatting is decided by the expression's static type, since
# JS numbers cannot distinguish 3.0 from 3 at runtime.
#>> 3.0
#>> 2.5
#>> t=1.0
#>> 4.0
X : float = 1.5 + 1.5
Print("{X}")
Print("{1.25 * 2.0}")
T : float = 1.0
Print("t=" + T)
Print(ToString(2.0 + 2.0))
