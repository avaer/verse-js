# Functions are first-class values: stored, passed, and invoked.
#>> 42
#>> 15
AddOne(X : int) : int = X + 1
Apply(F : type {_(:int) : int}, X : int) : int = F(X)
G := AddOne
Print("{G(41)}")
Print("{Apply(AddOne, 14)}")
