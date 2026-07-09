# Overloading by arity and by parameter type; most specific wins.
#>> int:5
#>> str:hi
#>> two:3
Show(X : int) : void = Print("int:{X}")
Show(S : string) : void = Print("str:{S}")
Add(A : int, B : int) : void = Print("two:{A + B}")
Show(5)
Show("hi")
Add(1, 2)
